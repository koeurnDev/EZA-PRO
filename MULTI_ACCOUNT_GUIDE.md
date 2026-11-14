# Gemini Router Management

The EZA PRO desktop app can store multiple Gemini API accounts and switch the active account for translation and OCR.

## Use the sidebar

1. Select **Router Management** in the top toolbar.
2. Expand **Add Gemini Account** and enter a display name, optional email, and API key.
3. Use **Switch to this account** to change the active key.
4. Use **Delete** to remove an account. Deleting the active account selects another saved account when available.

The sidebar only displays a masked key hint; the full API key is never sent back to the renderer. Account data is encrypted with Electron `safeStorage` and stored in the user's application data directory.

## Security and compatibility

- Account management is available in the EZA PRO desktop app, not the browser-only development page.
- Gemini keys are managed through the Electron preload/IPC bridge and are not accepted by `/api/accounts` or `/api/config`.
- Existing single Gemini keys and old `accounts.json` entries are migrated into encrypted account storage when the app starts.
- Other AI providers are not connected yet.
