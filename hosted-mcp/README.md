# Claude using ElevenLabs hosted MCP server

This example shows how the [ElevenLabs hosted MCP server](https://elevenlabs.io/docs/eleven-agents/operate/hosted-mcp) can expose agent management tools to AI assistants like Claude and help you prepare a YouTube voiceover by generating a draft script, analyzing the tone, selecting the best voice IDs from your account, and calling the ElevenLabs API to generate the audio files.


![System architecture](https://github.com/r0bert-t/elevenlabs-integration/blob/main/hosted-mcp/hosted_mcp_server.png)


## Technical Architecture

- **Client-Server Model**: Claude acts as the MCP client, while custom connectors allows to connect Claude to existing remote MCP servers.
- ElevenLabs platform exposes MCP server using a public endpoint reachable over the public Internet. It acts as a developer-friendly local interface that forwards requests to ElevenLabs’ cloud APIs.

  **ElevenLabs MCP server endpoint**
  ```
  https://api.elevenlabs.io/v1/mcp
  ```
- Authentication uses OAuth. It requires to sign in with your ElevenLabs account and grant the assistant scoped access to your workspace. There is no need to configure API keys. User authorize a connector so Claude will know which resources can access and which actions can dynamically invoke based on user prompts.

## Setup

### 1. Configure Claude Desktop to use Elevenlabs MCP

1. In Claude Desktop, navigate to to **Settings** > **Connectors** and browse the directory.
2. Search for **ElevenLabs** and select **Connect**.
3. Complete the OAuth flow with your ElevenLabs account. Choose the ElevenLabs workspace, review the requested permissions, and select Authorize.

> Please note that Claude can only perform actions covered by the permissions you approve, and access is limited to the ElevenLabs workspace you sign in with.

### 2. Use proper prompt for Claude
Paste one of the prompts above depending whether you want to use a generic Elevenlabs voices or your cloned voice.

**Sample prompt to use generic voices**
```
Act as an experienced YouTube scriptwriter and voiceover director.

Here is the profile of my voice:
- [Insert characteristics here, e.g., Male/Female, energetic, deep, calm, casual, fast-paced]
- Language: English

1. Write a highly engaging, conversational, [UPDATE WITH TIME DURATION]-second YouTube Shorts/Video script about "PASTE YOUR RAW TEXT OR TOPIC HERE" 
2. Include visual cues in brackets, pacing instructions, and specify the exact emotional tone for the speaker.
3. Review my available ElevenLabs voices via the MCP tool. Select a deep, cinematic, storytelling voice for this project.
4. Use the ElevenLabs MCP tool to generate the final audio files for the script segments.
```

**Sample prompt to use your cloned voice**
```
Act as an experienced YouTube scriptwriter and voiceover director. Your task is to transform the provided input text into a high-converting, natural-sounding voiceover script tailored for my cloned AI voice in ElevenLabs.

Here is the profile of my cloned voice:
- [Insert characteristics here, e.g., energetic, deep, calm, casual, fast-paced]
- Language: English

Strict Rules for ElevenLabs Text-to-Speech Optimization:
1. Include visual cues in brackets, pacing instructions, and specify the exact emotional tone for the speaker.
2. PACING VIA PUNCTUATION: Control the natural flow and breathing of the voice using punctuation:
   - Use commas (,) for short, natural breathing pauses.
   - Use em-dashes (—) or ellipses (...) to create dramatic beats or shifts in thought.
   - Use periods (.) to firmly end a thought before the next sentence.
3. SPELL OUT NUMBERS & SYMBOLS: Write out all numbers, dates, abbreviations, and symbols phonetically (e.g., instead of "in 2026 for $50k at 5%", write "in twenty twenty-six for fifty thousand dollars at five percent"). This prevents the AI from mispronouncing or rushing through them.
4. EMOTIONAL INFLECTION: Use question marks (?) and exclamation points (!) strategically to force the AI model to shift its vocal modulation, pitch, and intonation naturally.

Here is the source text or topic you need to rewrite into a voiceover script:
[PASTE YOUR RAW TEXT OR TOPIC HERE]
```

### Cloning your voice
[ElevenCreative](https://elevenlabs.io/docs/eleven-creative/overview) can create a digital replica of your voice that you can deploy in 32+ languages while matching the emotional register and prosody of your natural language. ElevenLabs offers [Instant Voice Cloning](https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/instant-voice-cloning) and [Professional Voice Cloning services](https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/professional-voice-cloning).

**Instant Voice Cloning** (available in the Free tier)
1. Login to ElevenLabs platform
2. Switch to **ElevenCreative**
2. Navigate to the **Instant Voice Cloning** page in **Voices**
2. Upload your samples or record audio

**Professional Voice Cloning**
To use Professional Voice Cloning service you must be subscribed to the Creator plan or higher.

For differences between Instant Voice Cloning and Professional Voice Cloning you can check this [article](https://help.elevenlabs.io/hc/en-us/articles/13313681788305-What-is-the-difference-between-Instant-Voice-Cloning-and-Professional-Voice-Cloning)

### 3. Approve the tool call

### 4. Download audio files

Once finished Claude will provide you the links to the generated .mp3 or .wav audio files, ready to be used straight in your video editor.

---

Created by [Robert Tracz](https://www.linkedin.com/in/robert-tracz/) 