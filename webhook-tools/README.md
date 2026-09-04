# Conversational AI agent using external knowledge database

 This example shows how ElevenLabs Conversational AI agent can be integrated with a Local Retrieval-Augmented Generation (RAG) pipeline and knowledge database. By leveraging the [ElevenLabs Webhook tool](https://elevenlabs.io/docs/eleven-agents/customization/tools/webhook-tools), the voice agent can dynamically query a local knowledge database during a live conversation, allowing it to provide accurate, context-aware, and data-driven spoken responses.
  
  
![System architecture](https://github.com/r0bert-t/elevenlabs-integration/blob/main/webhook-tools/elevenlabs-webhook-tool_v2.png)

## Logic

When a user asks a question requiring a specific knowledge, the ElevenLabs agent triggers a custom webhook tool. The local server processes the query using a local LLM, searches the vector database, extracts the relevant context, and returns it to the agent instantly to form a natural voice response.

```text
[User Voice] ──> [ElevenLabs Agent] ──(Webhook HTTP POST)──> [Local Server Gateway]
                                                                     │
[Natural Response] <── [ElevenLabs Agent] <── (JSON Response) ───────┴── [Local LLM + Vector DB]
```

## Workflow

1. **Trigger:** The user asks a question requiring use of knowledge database
2. **Webhook execution:** ElevenLabs interrupts or supplements its core prompt by calling the configured HTTP POST webhook tool
3. **Retrieval (RAG):** The local server embeds the query, searches the vector database, filters context, and optimizes the payload via a local LLM
4. **Delivery:** The structured text answer is stream back in chunks to ElevenLabs agent to be spoken to the user


## Setup

### 1. Set up local server webhook endpoint
Your local server must expose a public-facing webhook endpoint (or use a tunneling service like Ngrok for a local development) to accept incoming POST requests from ElevenLabs agent.

* **Endpoint URL:** `https://localserver/v1/chat/completions`
* **Method:** `POST`
* **Expected Request payload structure (from ElevenLabs):**
  ```json
  {
    "content": "Sample question"
  }
  ```
* **Expected Response payload structure (to ElevenLabs):**
  ```json
  {
    "context": "Sample response"
  }
  ```

#### API endpoint format
I this example we are using **/v1/chat/completions** endpoint format which is the standard technical protocol to generate text responses in a conversational format. Originally introduced by OpenAI for ChatGPT. ElevenLabs can use this API format to connect external AI agents (like OpenAI, DeepSeek, local RAGs) directly into ElevenLabs Conversational AI voice agents.


### 2. Configure custom tool in ElevenLabs platform
1. Navigate to the [ElevenLabs](https://elevenlabs.io) and open **ElevenAgents** dashboard
2. Go to the **Tools** tab and click **Add webhook tool**
3. Fill out the tool configuration parameters:
   * **Name:** `query_local_knowledge_db`
   * **Description:** Use a highly descriptive prompt so the agent knows when to invoke it. *Example: "Call this tool when the user asks specific, technical or internal operational questions that require the local knowledge database context."*
   * **URL:** Your local server's public endpoint (e.g., `https://localserver/v1/chat/completions`).
   * **Method:** `POST`
   * Set proper **Response timeout** (in seconds)
   * Configure Authentication:
     * Add custom header with following values:
       * **name:** elevenlabs-secret
       * **type:** secret
       * **value:** select **WEBHOOK_SECRET**
         * You can configure secret in ElevenLabs by navigating to workspace configuration and settings.
     
    > Please note that in this example we are using a very simple authentication using non-encrypted secret. In production deployment it is recommended to use more secure solutions. For more details please check [webhook-tool supported authentication methods](https://elevenlabs.io/docs/eleven-agents/customization/tools/webhook-tools#supported-authentication-methods)

   * Configure **Body parameters**. Below you can find a **api_schema** that will allow to use **/v1/chat/completions** webhook format endpoint


**Webhook tool configuration in JSON (API schema)**
```json
"api_schema": {
    "url": "https://localserver/v1/chat/completions",
    "method": "POST",
    "path_params_schema": [],
    "query_params_schema": [],
    "request_body_schema": {
      "id": "body",
      "type": "object",
      "description": "Query to knowledge db",
      "properties": [
        {
          "id": "messages",
          "type": "array",
          "description": "Array of message objects for Ollama chat completions",
          "items": {
            "type": "object",
            "properties": [
              {
                "id": "role",
                "type": "string",
                "description": "The role of the messages author (system or user)",
                "enum": ["system", "user"]
              },
              {
                "id": "content",
                "type": "string",
                "value_type": "llm_prompt",
                "description": "The content of the message containing the prompt context",
                "is_system_provided": false
              }
            ],
            "required": ["role", "content"]
          },
          "required": true
        }
      ],
      "required": ["messages"],
      "dynamic_variable": "",
      "value_type": "llm_prompt"
    },
```

## Architecture components

**1. API routing**

Built on top of FastAPI, this component manages the HTTP communication layer, authentication and data serialization (between the Elevenlabs conversational AI agent and internal knowledge database).

**2. Knowledge retrieval & vector database**

This component manages the persistence, indexing, and contextual search of the documentation.

**3. LLM orchestration**

This component manages prompt handling and processing queries. It interacts with local Ollama and LLM model.


---

Created by [Robert Tracz](https://www.linkedin.com/in/robert-tracz/) 