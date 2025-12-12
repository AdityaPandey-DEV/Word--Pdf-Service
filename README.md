# Word PDF Service

A Node.js service for converting DOCX files to PDF using LibreOffice. Designed to run on Render, Fly.io, or any Node.js hosting platform and handle both synchronous and asynchronous document conversion.

## Features

- ✅ DOCX to PDF conversion using LibreOffice headless mode
- ✅ Asynchronous processing (non-blocking)
- ✅ Webhook callbacks for completion notifications
- ✅ Error handling and logging
- ✅ Health check endpoint
- ✅ Docker support

## Prerequisites

- Node.js 18+
- LibreOffice installed
- Render account (or any Node.js hosting)

## Installation

### Local Development

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Install LibreOffice:
   ```bash
   # Ubuntu/Debian
   sudo apt-get update && sudo apt-get install -y libreoffice
   
   # macOS
   brew install libreoffice
   
   # Windows
   # Download from https://www.libreoffice.org/download/
   ```
4. Run the service:
   ```bash
   npm start
   ```

### Docker

```bash
docker build -t render-pdf-service .
docker run -p 10000:10000 render-pdf-service
```

## Environment Variables

- `PORT` - Server port (default: 10000)
- `RENDER_WEBHOOK_SECRET` - Secret for webhook verification (optional but recommended)
- `NODE_ENV` - Environment (development/production)

## API Endpoints

### POST /api/convert

Convert a DOCX file to PDF.

**Request:**
```json
{
  "docxUrl": "https://example.com/document.docx",
  "orderId": "ORD123456",
  "callbackUrl": "https://your-app.vercel.app/api/webhooks/render"
}
```

**Response:**
```json
{
  "success": true,
  "jobId": "job_ORD123456_1234567890",
  "message": "Conversion job started"
}
```

The service will:
1. Download the DOCX file from `docxUrl`
2. Convert it to PDF using LibreOffice
3. Send the PDF (base64 encoded) to `callbackUrl` via webhook

### POST /api/convert-sync

Convert a DOCX file to PDF synchronously (returns immediately with PDF).

**Request:**
```json
{
  "docxUrl": "https://example.com/document.docx"
}
```

**Response:**
```json
{
  "success": true,
  "pdfBuffer": "base64_encoded_pdf_content",
  "size": 123456
}
```

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "service": "word-pdf-service",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### GET /api/status/:jobId

Check conversion status (placeholder - use webhook for completion).

## Webhook Payload

When conversion completes, the service sends a POST request to `callbackUrl`:

**Success:**
```json
{
  "orderId": "ORD123456",
  "jobId": "job_ORD123456_1234567890",
  "pdfBuffer": "base64_encoded_pdf_content",
  "status": "completed"
}
```

**Failure:**
```json
{
  "orderId": "ORD123456",
  "jobId": "job_ORD123456_1234567890",
  "status": "failed",
  "error": "Error message"
}
```

## Deployment

### Option 1: Fly.io (Recommended)

1. Install Fly CLI: `curl -L https://fly.io/install.sh | sh`
2. Login: `fly auth login`
3. Deploy: `fly deploy`
4. The service will be available at `https://your-app-name.fly.dev`

### Option 2: Render (Using Dockerfile)

1. Create a new Web Service on Render
2. Connect your Git repository
3. Render will automatically detect the Dockerfile
4. Set environment variables:
   - `RENDER_WEBHOOK_SECRET` (optional)
   - `PORT` (default: 10000)
5. Deploy!

### Option 3: Render (Using Build Commands)

1. Create a new Web Service on Render
2. Connect your Git repository
3. Set build command:
   ```bash
   apt-get update && apt-get install -y libreoffice && npm install
   ```
4. Set start command:
   ```bash
   node server.js
   ```
5. Set environment variables
6. Deploy!

## Testing

### Test LibreOffice Installation

```bash
libreoffice --version
```

### Test Conversion Locally

```bash
libreoffice --headless --convert-to pdf --outdir ./output ./test.docx
```

### Test the Service

```bash
curl -X POST http://localhost:10000/api/convert \
  -H "Content-Type: application/json" \
  -d '{
    "docxUrl": "https://example.com/test.docx",
    "orderId": "test123",
    "callbackUrl": "https://your-app.vercel.app/api/webhooks/render"
  }'
```

## Troubleshooting

### LibreOffice not found
- Ensure LibreOffice is installed in the Docker image
- Check PATH: `which libreoffice`
- Use full path: `/usr/bin/libreoffice`

### Conversion fails
- Check Render logs for detailed error messages
- Verify DOCX file is accessible from Render
- Ensure sufficient disk space in temp directory

### Webhook not received
- Verify `callbackUrl` is correct and accessible
- Check `RENDER_WEBHOOK_SECRET` matches
- Review Render logs for webhook errors

## Performance

- First conversion may be slower (LibreOffice startup)
- Typical conversion: 5-30 seconds depending on document size
- Memory usage: ~200-500MB per conversion

## Security

- Always use HTTPS for webhook URLs
- Set `RENDER_WEBHOOK_SECRET` for webhook verification
- Validate input URLs (ensure they're from trusted sources)
- Consider rate limiting for production

## License

MIT

