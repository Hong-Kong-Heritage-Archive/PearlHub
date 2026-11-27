# GCP and Firebase Configuration Key Guide

Use this guide to supply the owner-managed values needed by PearlHub. Do not send private values in chat or commit them to Git.

## 1. GCP project

The confirmed project is `dllm-libray`. The project number is `795613264210`.

In Google Cloud Console:

1. Open **IAM & Admin > Settings**.
2. Confirm **Project ID** is `dllm-libray`.
3. Confirm billing is linked.

No project ID should be changed in the repository unless the deployment target changes.

## 2. Firebase web configuration

Open Firebase Console, select project `dllm-libray`, then open **Project settings > General > Your apps**.

For a Web app, add these public values to the frontend environment:

```dotenv
NEXT_PUBLIC_FIREBASE_API_KEY=<WEB_API_KEY>
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=dllm-libray.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=dllm-libray
NEXT_PUBLIC_FIREBASE_APP_ID=<WEB_APP_ID>
NEXT_PUBLIC_PEARLHUB_API_BASE_URL=<APPROVED_BACKEND_URL>
```

These are public Firebase client values. API keys are not server credentials and must not be replaced with a service-account private key.

Enable **Authentication > Sign-in method > Google** and **Email/Password** only after owner approval.

## 3. Firebase Admin ADC

Cloud Run should use a dedicated runtime service account and Application Default Credentials. Do not upload a service-account JSON key.

The backend requires:

```dotenv
NODE_ENV=production
PEARLHUB_AUTH_MODE=firebase
FIREBASE_PROJECT_ID=dllm-libray
```

For local ADC only:

```sh
gcloud auth application-default login
```

## 4. Cloud SQL

Confirmed instance:

- Instance: `dllm-libray:us-central1:dllm-libray-instance`
- PostgreSQL: `17`
- Region: `us-central1`
- Existing database: `community_chat`

Do not assume `community_chat` is intended for PearlHub. The owner must confirm the application database name.

Fill these placeholders:

```dotenv
CLOUD_SQL_DATABASE=<CONFIRMED_PEARLHUB_DATABASE_NAME>
CLOUD_SQL_USER=<DEDICATED_PEARLHUB_DATABASE_USER>
CLOUD_SQL_DATABASE_URL_SECRET=pearlhub-database-url
```

Create the Secret Manager value only as a complete PostgreSQL URL. Preferred Cloud SQL socket form:

```text
postgresql://<DATABASE_USER>:<DATABASE_PASSWORD>@/<DATABASE_NAME>?host=/cloudsql/dllm-libray:us-central1:dllm-libray-instance
```

This value is secret. Never print or commit it.

`CLOUD_SQL_DATABASE_URL_SECRET` is the **name of the secret**, such as
`pearlhub-database-url`. It must not be assigned the PostgreSQL URL itself.
Percent-encode reserved characters in the database username or password before
storing the URL; for example, `^` is `%5E` and `@` is `%40`.

## 5. Cloud Run runtime identity

Do not reuse the default compute account. Create or confirm a dedicated service account in Google Cloud, then fill:

```dotenv
CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT=<SERVICE_ACCOUNT_EMAIL>
```

Required access must be reviewed; no IAM role should be granted until the owner approves it.

## 6. Artifact Registry

The `gcf-artifacts` repository already exists, but the owner must confirm whether it is approved for backend releases. Fill:

```dotenv
ARTIFACT_REGISTRY_REPOSITORY=<APPROVED_REPOSITORY_NAME>
ARTIFACT_REGISTRY_IMAGE=pearlhub-backend
GCP_REGION=us-central1
```

## 7. Values to provide

The owner should provide only these missing values:

- Firebase Web app ID
- Firebase Web API key
- Firebase authorized domains and approved frontend origin
- PearlHub database name
- Dedicated runtime database user
- Secret Manager secret name
- Dedicated Cloud Run runtime service account
- Approved Cloud Run service name
- Approved Cloud Run region
- Approved Artifact Registry repository
- Backup/PITR owner and restore-test approval
