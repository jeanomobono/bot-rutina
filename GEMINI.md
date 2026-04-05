# Project Context: Ruti Backend API

## Purpose
This project is a private Node.js REST API designed to automate the logging of daily medical and care routines (feeding, medication, diapers, and peritoneal dialysis) for a pediatric renal patient. The backend receives audio recordings from a mobile app, uses the Gemini API to transcribe and structure the audio into JSON, and stores the data securely in an Oracle Database via Oracle REST Data Services (ORDS).

## Tech Stack
* **Backend:** Node.js (v20+), Express.js
* **File Handling:** Multer (for processing `multipart/form-data` audio uploads from the mobile app)
* **AI Integration:** Gemini API (`@google/generative-ai`, `gemini-2.5-flash` model) for audio-to-JSON extraction.
* **Database:** Oracle Database (Autonomous/OCI) exposed via ORDS.
* **Deployment:** Podman container (`node:20-alpine` image) running on an OCI ARM64 (Ampere) compute instance.

## Architecture & Data Flow
1. **Reception:** The mobile client (Flutter/Kotlin) sends an audio file via a `POST /api/procesar-audio` request.
2. **AI Processing:** Express uses Multer to handle the file in memory (`buffer`), converts it to Base64, and sends it to the Gemini API with a strict System Instruction to extract a structured JSON object.
3. **Authentication:** The server requests an OAuth2 (Client Credentials) token from ORDS. An in-memory cache strategy is used to reuse valid tokens and minimize redundant HTTP requests.
4. **Insertion:** The server sends a HTTP POST request with the JSON payload to the corresponding ORDS endpoint and returns a success response to the mobile client.

## Project Structure
* `/sql/`: Contains database DDL scripts and PL/SQL configurations for ORDS modules, privileges, and OAuth2 clients (e.g., `ORDS_auth.sql`, `ORDS_endpoints.sql`, `Tablas_RegMed.sql`).
* `/index.js` (or `server.js`): Main Express server application containing the routing, Multer middleware, Gemini integration, and ORDS API calls.
* `/.env`: (Ignored by Git) Contains `GEMINI_API_KEY` and `ORDS_*` configuration variables.
* `Dockerfile` / `.dockerignore`: Container build instructions optimized for the ARM64 environment and efficient layer caching.

## Strict Development Guidelines
When suggesting code, refactoring, or debugging this project, adhere strictly to these rules:

1. **Network Configuration (IPv4):** All outbound HTTP requests using `axios` must explicitly force IPv4 (`httpsAgent: new https.Agent({ family: 4 })`) to prevent `ETIMEDOUT` or `AggregateError` issues caused by Node.js IPv6 resolution in the OCI environment.
2. **Security & Secrets:** Never suggest hardcoding credentials. Always use `process.env`.
3. **Asynchronous Error Handling:** Use `try/catch` blocks for all network operations (Gemini, ORDS). If the AI returns an unexpected format, ensure `JSON.parse` is wrapped in a way that catches the error before attempting to send malformed data to Oracle.
4. **ORDS Resilience:** The ORDS API is secured by OAuth2. Successful resource creation endpoints return a `201 Created` HTTP status code. Handle other status codes as errors.
5. **Gemini JSON Output:** The Gemini System Prompt is strictly instructed to avoid Markdown formatting (e.g., ` ```json `). When handling the AI response, always apply `.replace(/```json/gi, '').replace(/```/g, '').trim()` before parsing to prevent breaking the application if the model hallucinates formatting.