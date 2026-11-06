"""
Manages client secret retrieval from ElevenLabs platform.
"""

import time

from elevenlabs import (
    CreateClientSecretRequest,
    ExpiresAfter,
    OpenAiAudioConfigInput,
    OpenAiAudioInputConfigInput,
    OpenAiAudioInputFormat,
    OpenAiAudioOutputConfigInput,
    OpenAiAudioOutputFormat,
    OpenAiSessionConfigInput,
    OpenAiTurnDetection,
)
from elevenlabs.client import ElevenLabs
from flask import Flask, jsonify, request, send_from_directory


ELEVENLABS_API_KEY = "<KEY>"


elevenlabs = ElevenLabs(api_key=ELEVENLABS_API_KEY)
app = Flask(__name__)


def mint_client_secret():
    """
    Ask ElevenLabs for a short-lived client secret scoped to the session config.
    """
    secret = elevenlabs.conversational_ai.realtime.create_client_secret(
        request=CreateClientSecretRequest(
            session=OpenAiSessionConfigInput(
                type="realtime",
                model="eleven_realtime_v1_mini",
                instructions="You are a helpful, friendly voice assistant. Keep replies concise.",
                output_modalities=["audio"],
                audio=OpenAiAudioConfigInput(
                    input=OpenAiAudioInputConfigInput(
                        format=OpenAiAudioInputFormat(type="audio/pcm", rate=24000),
                        turn_detection=OpenAiTurnDetection(type="semantic_vad", eagerness="medium"),
                    ),
                    output=OpenAiAudioOutputConfigInput(
                        format=OpenAiAudioOutputFormat(type="audio/pcm"),
                        voice="brian",
                    ),
                ),
            ),
            expires_after=ExpiresAfter(anchor="created_at", seconds=600),
        ),
    )
    return {"value": secret.value, "minted_at": int(time.time())}


@app.post("/api/token")
def api_token():
    """
    API endpoint for a short-lived client secret retrieval.
    """
    try:
        data = mint_client_secret()
    except Exception:
        app.logger.exception("Cannot retrieve client secret from ElevenLabs platform")
        return jsonify(error="Error when retrieving client secret"), 502
    # Return only the value to the browser
    return jsonify(value=data["value"])


if __name__ == "__main__":
    # Run Flask server on port 3000
    app.run(host="127.0.0.1", port=3000, debug=False)