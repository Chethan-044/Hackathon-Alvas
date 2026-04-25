/**
 * Extension ingestion routes.
 * POST /api/extension/ingest — receives scraped reviews from Chrome Extension,
 * runs them through the Python NLP pipeline, persists to MongoDB,
 * and broadcasts via Socket.io.
 */
const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const pythonBridge = require('../services/pythonBridge');
const ScrapedReview = require('../models/ScrapedReview');
const issueService = require('../services/issueService');
const { sendIssueAlert } = require('../services/emailService');

const router = express.Router();

router.use(authMiddleware);

router.post('/ingest', async (req, res) => {
  try {
    const {
      reviewId,
      hotelName,
      text,
      rating,
      reviewer,
      timestamp,
      language,
      source,
      url,
      scrapedAt,
    } = req.body;

    // ── Validate required fields ──────────────────────────────
    if (!reviewId || !text || !hotelName) {
      return res.status(400).json({
        success: false,
        message: 'reviewId, text, and hotelName are required',
      });
    }

    // ── Check for duplicate ───────────────────────────────────
    const exists = await ScrapedReview.findOne({ reviewId });
    if (exists) {
      return res.json({
        success: true,
        duplicate: true,
        message: 'Review already processed',
        sentiment: exists.overallSentiment
          ? { sentiment: exists.overallSentiment, confidence: exists.sentimentConfidence }
          : null,
      });
    }

    // ── Step 1: Forward to Python NLP ─────────────────────────
    let analysis = null;
    let features = [];
    let overall = {};
    let isBotReview = false;
    let botReasons = [];

    try {
      const result = await pythonBridge.analyzeSingleReview(text, hotelName);
      analysis = result;
      features = result?.analysis?.features || [];
      overall = result?.analysis?.overall_sentiment || {};
      isBotReview = result?.review?.is_bot || false;
      botReasons = result?.review?.bot_reasons || [];
    } catch (nlpErr) {
      console.error('[extension/ingest] Python NLP failed:', nlpErr.message);
      // Proceed with basic data even if NLP fails
      overall = { sentiment: 'NEUTRAL', confidence: 0, is_sarcastic: false, needs_human_review: true };
    }

    const primarySentiment = overall.sentiment || 'NEUTRAL';
    const sentimentLabel =
      primarySentiment.includes('NEG') ? 'Negative' :
      primarySentiment.includes('POS') ? 'Positive' :
      primarySentiment.includes('SARC') ? 'Sarcastic' : 'Neutral';

    // ── Step 2: Save to MongoDB ───────────────────────────────
    const doc = await ScrapedReview.create({
      reviewId,
      hotelName,
      text,
      cleanedText: analysis?.review?.cleaned_text || text,
      rating: rating || null,
      reviewer: reviewer || 'Anonymous',
      timestamp: timestamp || '',
      language: language || 'en',
      detectedLanguage: analysis?.review?.detected_language || language || 'en',
      wasTranslated: analysis?.review?.was_translated || false,
      source: source || 'google_maps',
      url: url || '',
      scrapedAt: scrapedAt ? new Date(scrapedAt) : new Date(),
      overallSentiment: primarySentiment,
      sentimentConfidence: Number(overall.confidence || 0),
      isSarcastic: overall.is_sarcastic || false,
      needsHumanReview: overall.needs_human_review || false,
      isBot: isBotReview,
      botReasons,
      featureSentiments: features.map((f) => ({
        feature: f.feature,
        sentiment: f.sentiment,
        confidence: f.confidence,
        keywords: f.keywords_found || [],
        snippet: f.relevant_snippet || '',
      })),
      analyzedAt: new Date(),
    });

    // ── Step 3: Issue detection + escalation ──────────────────
    const primaryFeature = features[0]?.feature || 'general';
    const cluster =
      sentimentLabel === 'Negative'
        ? `${primaryFeature.charAt(0).toUpperCase() + primaryFeature.slice(1)} Issue`
        : sentimentLabel === 'Positive'
          ? `${primaryFeature.charAt(0).toUpperCase() + primaryFeature.slice(1)} Praise`
          : `${primaryFeature.charAt(0).toUpperCase() + primaryFeature.slice(1)} Mixed Feedback`;

    let isCritical = false;
    let topic = null;

    try {
      const issueResult = await issueService.upsertIssue({
        topic: cluster,
        sku: hotelName,
        category: sentimentLabel === 'Negative' ? 'complaint' : 'praise',
        reviewText: text,
        sentiment: sentimentLabel,
        timestamp: scrapedAt || new Date().toISOString(),
      });

      if (issueResult && issueResult.priority === 'critical') {
        isCritical = true;
        topic = cluster;

        // ── Send email alert for critical emerging issues ──
        sendIssueAlert({
          to: process.env.ALERT_EMAIL,
          issue: cluster,
          severity: 'Critical',
          occurrences: issueResult.occurrences || 1,
          feature: primaryFeature,
          sentiment: sentimentLabel,
          recommendation: `Multiple negative reviews detected for "${primaryFeature}" on ${hotelName}. Immediate attention recommended.`,
          latestReview: text.slice(0, 300),
          sku: hotelName,
        }).catch((emailErr) => {
          console.error('[extension/ingest] Email alert failed:', emailErr.message);
        });
      }
    } catch (issueErr) {
      console.error('[extension/ingest] Issue service error:', issueErr.message);
    }

    // ── Step 4: Socket.io broadcast ───────────────────────────
    const io = req.app.get('io');
    if (io) {
      // Broadcast review to all dashboards
      io.to('global_feed').emit('review_update', {
        sku: hotelName,
        review: text,
        feature: primaryFeature.charAt(0).toUpperCase() + primaryFeature.slice(1),
        sentiment: sentimentLabel,
        confidence: Number(overall.confidence || 0),
        cluster,
        is_emerging_issue: sentimentLabel === 'Negative',
        issue_severity: isCritical ? 'Critical' : 'Low',
        recommendation: '',
        timestamp: 'live',
        source: 'google_maps',
      });

      // If critical, emit to admin dashboards too (handled by issueService)
    }

    console.log(
      `[extension/ingest] ✓ Processed review ${reviewId} for "${hotelName}" → ${primarySentiment}`
    );

    // ── Step 5: Response to extension ─────────────────────────
    res.json({
      success: true,
      isCritical,
      topic,
      sentiment: { sentiment: primarySentiment, confidence: overall.confidence || 0 },
      aspects: features.map((f) => ({
        aspect: f.feature,
        sentiment: f.sentiment,
        score: f.confidence,
      })),
      isSpam: isBotReview,
    });
  } catch (err) {
    console.error('[extension/ingest] Error:', err.message);

    // Handle duplicate key error gracefully
    if (err.code === 11000) {
      return res.json({
        success: true,
        duplicate: true,
        message: 'Review already exists',
      });
    }

    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

// ── GET /api/extension/reviews — fetch historical scraped reviews ──
router.get('/reviews', async (req, res) => {
  try {
    const { hotelName, limit } = req.query;
    const filter = {};
    if (hotelName) filter.hotelName = hotelName;

    const reviews = await ScrapedReview.find(filter)
      .sort({ scrapedAt: -1 })
      .limit(parseInt(limit, 10) || 500)
      .lean();

    res.json({ success: true, data: reviews });
  } catch (err) {
    console.error('[extension/reviews] Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});


// ── POST /api/extension/ingest-batch — batch ingest endpoint ──
router.post('/ingest-batch', async (req, res) => {
  try {
    const { reviews } = req.body;
    if (!Array.isArray(reviews) || reviews.length === 0) {
      return res.status(400).json({ success: false, message: 'No reviews provided' });
    }

    // Validate all reviews minimally
    const invalid = reviews.find(r => !r.reviewId || !r.text || !r.hotelName);
    if (invalid) {
      return res.status(400).json({ success: false, message: 'Each review must have reviewId, text, and hotelName' });
    }

    // Check for duplicates in DB
    const reviewIds = reviews.map(r => r.reviewId);
    const existing = await ScrapedReview.find({ reviewId: { $in: reviewIds } }).lean();
    const existingIds = new Set(existing.map(r => r.reviewId));
    const newReviews = reviews.filter(r => !existingIds.has(r.reviewId));

    let processed = 0;
    let duplicates = reviews.length - newReviews.length;
    let results = [];

    if (newReviews.length > 0) {
      // Batch analyze in Python
      let analysisResults = [];
      try {
        analysisResults = await pythonBridge.analyzeReviews(
          newReviews.map(r => r.text),
          newReviews[0].hotelName,
          null
        );
      } catch (err) {
        console.error('[extension/ingest-batch] Python batch NLP failed:', err.message);
        // Fallback: mark all as NEUTRAL
        analysisResults = newReviews.map(() => ({
          analysis: { overall_sentiment: { sentiment: 'NEUTRAL', confidence: 0, is_sarcastic: false, needs_human_review: true }, features: [] },
          review: { cleaned_text: '', detected_language: 'en', was_translated: false, is_bot: false, bot_reasons: [] }
        }));
      }

      // Save each new review
      for (let i = 0; i < newReviews.length; i++) {
        const r = newReviews[i];
        const analysis = analysisResults[i] || {};
        const features = analysis?.analysis?.features || [];
        const overall = analysis?.analysis?.overall_sentiment || {};
        const isBotReview = analysis?.review?.is_bot || false;
        const botReasons = analysis?.review?.bot_reasons || [];
        const primarySentiment = overall.sentiment || 'NEUTRAL';

        await ScrapedReview.create({
          reviewId: r.reviewId,
          hotelName: r.hotelName,
          text: r.text,
          cleanedText: analysis?.review?.cleaned_text || r.text,
          rating: r.rating || null,
          reviewer: r.reviewer || 'Anonymous',
          timestamp: r.timestamp || '',
          language: r.language || 'en',
          detectedLanguage: analysis?.review?.detected_language || r.language || 'en',
          wasTranslated: analysis?.review?.was_translated || false,
          source: r.source || 'google_maps',
          url: r.url || '',
          scrapedAt: r.scrapedAt ? new Date(r.scrapedAt) : new Date(),
          overallSentiment: primarySentiment,
          sentimentConfidence: Number(overall.confidence || 0),
          isSarcastic: overall.is_sarcastic || false,
          needsHumanReview: overall.needs_human_review || false,
          isBot: isBotReview,
          botReasons,
          featureSentiments: features.map((f) => ({
            feature: f.feature,
            sentiment: f.sentiment,
            confidence: f.confidence,
            keywords: f.keywords_found || [],
            snippet: f.relevant_snippet || '',
          })),
          analyzedAt: new Date(),
        });
        processed++;
        results.push({ reviewId: r.reviewId, sentiment: primarySentiment });
      }
    }

    res.json({ success: true, processed, duplicates, results });
  } catch (err) {
    console.error('[extension/ingest-batch] Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
