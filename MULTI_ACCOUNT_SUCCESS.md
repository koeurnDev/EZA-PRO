# Gemini Router Management

The earlier `/api/accounts/*` implementation stored full API keys in `accounts.json`. It has been replaced by the desktop **Router Management** sidebar.

The current implementation:

- Adds, lists, switches, and deletes Gemini accounts in the app.
- Keeps full API keys in Electron `safeStorage`-encrypted user data; only masked hints reach the renderer.
- Uses the selected account for Gemini-backed translation and OCR.
- Migrates an existing single saved Gemini key into the account list at startup.

See [MULTI_ACCOUNT_GUIDE.md](./MULTI_ACCOUNT_GUIDE.md) for user instructions.
