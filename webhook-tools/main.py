"""
Allows to ElevenLabs Conversational AI agent to be integrated with a Local Retrieval-Augmented Generation (RAG) pipeline and query knowledge database
"""

import json
import asyncio
from fastapi import FastAPI, Request, HTTPException, status
from fastapi.responses import StreamingResponse
import ollama
import chromadb
from pyngrok import ngrok
import uvicorn

# Webhook auth secret
WEBHOOK_SECRET = "<SECRET>>"

# ngrok auth token
ngrok.set_auth_token("<AUTH_TOKEN>")

app = FastAPI()

# Initialize local ChromaDB
chroma_client = chromadb.PersistentClient(path="./chroma_db")
collection = chroma_client.get_or_create_collection(name="knowledge_base")

# Sample business data
raw_documents = [
    "Company xyz return policy allows product returns within 30 days of purchase.",
    "The support hotline hours are 8:00 AM - 6:00 PM, Monday through Friday.",
    "Company policy allows to exchange products if they are brand new."
]
doc_ids = ["doc1", "doc2", "doc3"]

# Initialize local Ollama Embeddings
embeddings_list = []
for doc in raw_documents:
    response = ollama.embeddings(model="nomic-embed-text", prompt=doc)
    embeddings_list.append(response["embedding"])

# Seed the vector database by providing the embeddings
collection.add(
    embeddings=embeddings_list,
    documents=raw_documents,
    ids=doc_ids
)


def retrieve_context(query: str) -> str:
    """
    Retrieves relevant context chunks from ChromaDB using local Ollama embeddings
    """
    try:
        # Generate embeddings using a lightweight local model
        response_emb = ollama.embeddings(model="nomic-embed-text", prompt=query)
        query_embedding = response_emb["embedding"]

        # Query the vector database
        results = collection.query(
            query_embeddings=[query_embedding],
            n_results=1
        )

        if results and results['documents'] and len(results['documents']) > 0:
            return " ".join(results['documents'][0])
    except Exception as e:
        print(f"RAG Error: {e}")
    return ""


async def ollama_stream_generator(prompt: str, context: str):
    """
    Streams data from Ollama formatted exactly as OpenAI-compatible SSE chunks for ElevenLabs
    """

    system_prompt = (
        f"You are a helpful, conversational voice assistant. Keep answers concise and direct. "
        f"Use the following piece of context to answer the user's question:\n\n{context}"
    )

    # Trigger local LLM streaming
    response_stream = ollama.chat(
        model="llama3.2:3b",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt}
        ],
        stream=True
    )

    # Yield chunks matching the OpenAI chat completions structure expected by ElevenLabs
    for chunk in response_stream:
        content = chunk.get('message', {}).get('content', '')
        if content:
            data = {
                "choices": [
                    {
                        "delta": {"content": content},
                        "finish_reason": None,
                        "index": 0
                    }
                ]
            }
            yield f"data: {json.dumps(data)}\n\n"
            await asyncio.sleep(0.005)

    # Signal the end of the streaming payload
    end_data = {
        "choices": [
            {
                "delta": {},
                "finish_reason": "stop",
                "index": 0
            }
        ]
    }
    yield f"data: {json.dumps(end_data)}\n\n"
    yield "data: [DONE]\n\n"


@app.post("/v1/chat/completions")
async def custom_llm_webhook(request: Request):
    """
    The webhook endpoint acting as a custom LLM provider for ElevenLabs conversational AI agent
    """
    payload = await request.body()
    body = await request.json()

    secret = request.headers.get("elevenlabs-secret")

    # Authenticate agent using a secret
    if secret == WEBHOOK_SECRET:
        print("[ Successfully verified webhook secret ]")
    else:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid secret"
        )

    # Parse user message from ElevenLabs conversation history
    messages = body.get("messages", [])
    user_query = ""
    for msg in reversed(messages):
        if msg.get("role") == "user":
            user_query = msg.get("content", "")
            break

    print(f"[ ElevenLabs agent query ]: {user_query}")

    # Execute RAG Retrieval
    context = retrieve_context(user_query)
    print(f"[ Retrieved Context ]: {context}")

    # Stream LLM synthesis back over SSE
    return StreamingResponse(
        ollama_stream_generator(user_query, context),
        media_type="text/event-stream"
    )


if __name__ == "__main__":
    public_url = ngrok.connect(8000)
    print(f"Public URL: {public_url}")
    # Start server on local port 8000
    uvicorn.run(app, host="0.0.0.0", port=8000)