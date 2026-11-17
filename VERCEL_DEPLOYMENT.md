# Vercel deployment package

## Deploy
1. Extract this ZIP and upload the project to a new GitHub repository.
2. In Vercel, choose **Add New → Project**, import that GitHub repository, and deploy.
3. Set the project environment variable `SETUP_TOKEN` to a long random one-time secret before deploying. Use the same value only for the initial administrator setup.
4. Use Node.js 24.x in the Vercel project settings if a runtime selector is shown.
5. After deployment, create the first administrator by sending a POST request to `https://YOUR-DOMAIN/api/setup` with JSON:
   `{ "setup_token":"YOUR_SETUP_TOKEN", "username":"admin", "email":"you@example.com", "password":"a-unique-password-at-least-14-characters" }`
6. Sign in at the deployed site. Once the first administrator is created, the setup endpoint rejects further account creation. Remove `SETUP_TOKEN` from the Vercel environment and redeploy.

## IMPORTANT: data persistence limitation

This package adds a Vercel serverless adapter so the web UI and API can be deployed and tested on Vercel. **It is not yet production-safe for real staff records.** The current application uses SQLite (`node:sqlite`) and an in-memory session map. Vercel serverless functions have temporary instance storage and can be restarted or scaled across instances. The SQLite database under `/tmp` and login sessions can therefore disappear or differ between invocations. A redeploy can also start with an empty database.

Before using this for institutional or personal staff data, migrate the database to a persistent managed database (preferably PostgreSQL, e.g. Neon or Supabase) and store sessions in a shared persistent session store. The current schema and SQL statements are SQLite-specific, so simply adding a database URL is not enough. Do not upload the included local SQLite backup or real employee data to a public GitHub repository.

## Local development

Requires Node.js 24+. Run `npm start`, then open `http://127.0.0.1:8080`. Initialize with `npm run init-db` if desired. The Vercel adapter does not change the local development workflow.
