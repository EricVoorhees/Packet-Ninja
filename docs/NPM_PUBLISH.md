# NPM Publish Runbook

Use this every time you publish `package-ninja` so the process is repeatable and low-risk.

## 1. Preconditions

- You are on the correct branch and commit.
- `package.json` has the intended version.
- You have a valid npm token with publish rights for `package-ninja`.

## 2. Windows-safe environment setup

If `C:` is low on space, set temp/cache to `D:` before publish:

```powershell
$env:TEMP='D:\_tmp'
$env:TMP='D:\_tmp'
$env:GOTMPDIR='D:\_tmp\go-build'
$env:GOCACHE='D:\_tmp\go-cache'
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
New-Item -ItemType Directory -Path $env:GOTMPDIR -Force | Out-Null
New-Item -ItemType Directory -Path $env:GOCACHE -Force | Out-Null
```

## 3. Authenticate npm

```powershell
npm config set //registry.npmjs.org/:_authToken "<YOUR_NPM_TOKEN>"
npm whoami
```

`npm whoami` must succeed before publishing.

## 4. Dry run package contents

```powershell
npm pack --dry-run
```

Verify:

- version is correct
- expected `dist/` and `bin/` files are included
- no accidental files are included

## 5. Publish

```powershell
npm publish --access public
```

## 6. Verify live version

```powershell
npm view package-ninja version dist-tags --json
npm view package-ninja@<VERSION> version --json
```

`latest` should point to the version you just published.

## 7. Security follow-up

- Rotate/revoke any token that was shared in chat or logs.
- Keep tokens out of repo files.

## Common failure checks

- `401 Unauthorized`: token invalid/expired/wrong scope.
- `404 Not Found` on publish: account/token cannot publish this package name.
- Go build space errors: ensure temp/cache env vars are set to a drive with free space.
