"""
Loads HuggingFace models once at startup and exposes singleton accessors.
All models run on CPU (device=-1).
"""

from typing import Any, Dict, Optional
from transformers import pipeline


class ModelLoader:
    """
    Singleton-style loader for sentiment, ABSA, irony, and translation pipelines.
    """

    is_loaded: bool = False
    SENTIMENT_MODEL: Optional[Any] = None
    ABSA_MODEL: Optional[Any] = None
    IRONY_MODEL: Optional[Any] = None
    TRANSLATION_MODEL: Optional[Any] = None

    SENTIMENT_MODEL_NAME = "cardiffnlp/twitter-roberta-base-sentiment-latest"
    ABSA_MODEL_NAME = "yangheng/deberta-v3-base-absa-v1.1"
    IRONY_MODEL_NAME = "cardiffnlp/twitter-roberta-base-irony"
    TRANSLATION_MODEL_NAME = "Helsinki-NLP/opus-mt-hi-en"

    @classmethod
    def load_all(cls) -> None:
        """Initialize all pipelines on CPU."""
        try:
            print("[ModelLoader] Loading SENTIMENT_MODEL...")
            cls.SENTIMENT_MODEL = pipeline(
                "sentiment-analysis",
                model=cls.SENTIMENT_MODEL_NAME,
                device=-1,
            )
        except Exception as e:
            print("❌ SENTIMENT_MODEL failed:", e)

        try:
            print("[ModelLoader] Loading ABSA_MODEL...")
            cls.ABSA_MODEL = pipeline(
                "text-classification",
                model=cls.ABSA_MODEL_NAME,
                device=-1,
            )
        except Exception as e:
            print("❌ ABSA_MODEL failed:", e)

        try:
            print("[ModelLoader] Loading IRONY_MODEL...")
            cls.IRONY_MODEL = pipeline(
                "text-classification",
                model=cls.IRONY_MODEL_NAME,
                device=-1,
            )
        except Exception as e:
            print("❌ IRONY_MODEL failed:", e)

        try:
            print("[ModelLoader] Loading TRANSLATION_MODEL...")
            cls.TRANSLATION_MODEL = pipeline(
                "text-generation",  # ✅ compatible with your transformers
                model=cls.TRANSLATION_MODEL_NAME,
                device=-1,
            )
        except Exception as e:
            print("❌ TRANSLATION_MODEL failed:", e)

        cls.is_loaded = True
        print("[ModelLoader] All models attempted to load.")

    @classmethod
    def translate(cls, text: str) -> str:
        """Translate Hindi → English using text-generation pipeline."""
        if not cls.TRANSLATION_MODEL:
            return text

        try:
            result = cls.TRANSLATION_MODEL(
                f"Translate Hindi to English: {text}",
                max_length=100
            )
            return result[0]["generated_text"]
        except Exception as e:
            print("❌ Translation failed:", e)
            return text

    @classmethod
    def get_status(cls) -> Dict[str, Any]:
        """Return readiness flags for each model."""
        return {
            "is_loaded": cls.is_loaded,
            "sentiment_ready": cls.SENTIMENT_MODEL is not None,
            "absa_ready": cls.ABSA_MODEL is not None,
            "irony_ready": cls.IRONY_MODEL is not None,
            "translation_ready": cls.TRANSLATION_MODEL is not None,
            "model_names": {
                "sentiment": cls.SENTIMENT_MODEL_NAME,
                "absa": cls.ABSA_MODEL_NAME,
                "irony": cls.IRONY_MODEL_NAME,
                "translation": cls.TRANSLATION_MODEL_NAME,
            },
        }