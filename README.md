# Todo AI

Todo AI is an Electron, React, and TypeScript desktop app for task planning with local AI support.

## Development

Install dependencies:

```powershell
npm install
```

Start Vite and the Electron desktop app:

```powershell
npm run dev
```

Build the renderer:

```powershell
npm run build
```

## Windows Installer

Create a local Windows NSIS installer without publishing:

```powershell
npm run dist
```

The installer and update metadata are written to `release/`. The installer is named like:

```text
Todo AI Setup x.x.x.exe
```

## GitHub Releases

Publishing uses `electron-builder` with the GitHub provider configured in `package.json`:

```json
{
  "provider": "github",
  "owner": "ArturKamnev",
  "repo": "todo-list"
}
```

Do not hardcode GitHub tokens. Set `GH_TOKEN` in the environment before running the release command.

PowerShell:

```powershell
$env:GH_TOKEN="ghp_your_token_here"
npm run release
```

Command Prompt:

```cmd
set GH_TOKEN=ghp_your_token_here
npm run release
```

The token needs permission to create and upload GitHub Releases for the repository.

## Publishing A New Version

Update the app version, push the commit and tag, then publish:

```powershell
npm version patch
git push origin main --follow-tags
npm run release
```

Users install Todo AI from the Windows installer attached to GitHub Releases. Future releases are discovered through `electron-updater` using the release metadata uploaded by `npm run release`.
