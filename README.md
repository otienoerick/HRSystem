# University Staff and Leave Management System

This repository contains the staff management portal and a Vercel serverless entry point.

- Local setup: see below.
- Vercel deployment: read [VERCEL_DEPLOYMENT.md](VERCEL_DEPLOYMENT.md).
- Database schema: `database/schema.sql`.
- Technical notes: `docs/architecture.md` and `docs/security.md`.

## Local run

Requires Node.js 24 or newer.

```bash
npm start
```

Open `http://127.0.0.1:8080`. Set `SETUP_TOKEN` before starting the server and use it once at `POST /api/setup` to create the first administrator. Use a password of at least 14 characters.

## Deployment warning

The Vercel adapter is intended for deployment testing only. This version uses SQLite and process-local sessions, which are not durable/shared on Vercel serverless infrastructure. Do not use it for live staff records until the application is migrated to a managed PostgreSQL database and shared session storage. See `VERCEL_DEPLOYMENT.md`.
