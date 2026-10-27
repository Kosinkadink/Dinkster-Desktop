# Desktop signing

How Dinkster Desktop releases get a verified publisher on Windows (Azure
Artifact Signing) and macOS (Apple Developer ID with notarization). Both
platforms sign as the individual account holder; converting to the company is a
later, optional step covered at the end. Never put identity documents,
passwords, private keys, client secrets, personal street addresses, or account,
subscription, tenant, or enrollment identifiers in this repository, support
posts, build logs, or the installed application. The signing account name, the
certificate profile name, the regional endpoint, and the certificate subject
are public: they appear on every signed binary.

## Windows

### What is set up

The Windows path uses Microsoft's Artifact Signing service, formerly Trusted
Signing: a managed Public Trust certificate, no EV token and no Key Vault. The
portal says Artifact Signing; electron-builder 26 still says Trusted Signing
and `azureSignOptions`. Resources that exist, all in the subscription's West
US 2 region:

- Artifact Signing account `dinkster`, Basic tier, endpoint
  `https://wus2.codesigning.azure.net`.
- A Completed Public identity validation of type Individual for the account
  holder, imported from the subscription's Individual billing account.
- Certificate profile `dinkster-desktop` of type Public Trust. Its subject
  carries the legal name as CN and O plus city, state, and country; street
  address and postal code are excluded.

Keep the account; do not create a second one or buy a certificate elsewhere.
Identity validations are scoped to the subscription, so a later company
validation can live beside this one.

### Build configuration

[packages/desktop/package.json](../packages/desktop/package.json) stays
unsigned (`win.forceCodeSigning: false`, no `azureSignOptions`) so local and
validation builds need no Azure credentials.
[packages/desktop/electron-builder.signed.mjs](../packages/desktop/electron-builder.signed.mjs)
is the release configuration: it reuses the `build` object from package.json
and adds `win.forceCodeSigning: true` plus `win.azureSignOptions` with the
account, profile, endpoint, and certificate common name. The script
`pnpm --filter @dinkster/desktop package:win:signed` runs the normal packaging
chain with `--config electron-builder.signed.mjs`.

Two publisher settings matter and they differ:

- `win.azureSignOptions.publisherName` is the certificate common name, exactly
  as issued, and must be a single string; the installed builder's schema
  rejects an array here.
- `publish[0].publisherName` is the list of publishers an installed
  application accepts when it verifies the signature of a downloaded update.
  It is written to the application's `app-update.yml`. The list holds the
  current publisher and `Dinkster Inc`, so installs shipped now will accept a
  later company-signed release. Never remove the current publisher while
  installs signed by it exist.

The builder installs the `TrustedSigning` PowerShell module for the current
user and calls `Invoke-TrustedSigning` for every executable, so the build
machine needs Windows PowerShell 5.1 or later and access to PowerShell Gallery
and the endpoint. Authentication comes only from the environment:
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET`.

### Give the build its own identity

Follow Microsoft's [role assignment tutorial](https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles):

1. Entra ID -> App registrations -> New registration, single tenant, no
   redirect URI. Record the Application (client) ID and Directory (tenant) ID.
2. Certificates & secrets -> New client secret. Copy the Value once into a
   password manager; the Secret ID is not the credential. Microsoft recommends
   certificate or federated credentials over client secrets for production;
   a short-lived secret is acceptable for the first signed builds.
3. On the `dinkster` account (or the certificate profile) -> Access control
   (IAM) -> Add role assignment -> **Artifact Signing Certificate Profile
   Signer** -> assign to the app registration. Owner or Contributor on the
   subscription does not grant signing. Allow a few minutes to propagate.
4. In the GitHub repository settings add Actions secrets `AZURE_TENANT_ID`,
   `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET`. The
   [release workflow](../.github/workflows/release-desktop.yml) and the
   [signed package workflow](../.github/workflows/signed-package.yml) pass
   them only to their packaging step.

### Sign in GitHub Actions without releasing

The **Windows signed package** workflow (`signed-package.yml`) is manual and
runs from any branch of this repository. It builds the pinned frontend,
packages with `package:win:signed`, verifies both signatures, installs into a
scratch directory, exercises first launch, and keeps the installer plus its
SHA256 as the `desktop-signed-installer` artifact for 14 days. It never
creates a tag or release and does not run the main validation gate, so it is
the fastest way to prove the signing setup or to hand testers a signed build.
Actions -> Windows signed package -> Run workflow -> pick the branch.

The **Windows Desktop release** workflow adds the gate and the publication:
it runs the full main validation first, then the same signing and
verification steps, then creates the GitHub release. The version is not an
input: it is `version` in
[packages/desktop/package.json](../packages/desktop/package.json), and the
tag is `desktop-v<version>`. The workflow refuses to publish when that tag
already exists, so every release starts with a commit on main that bumps the
version.

### Sign locally

In PowerShell at the repository root, with the pinned frontend built and the
pinned backend archive and Aimdo wheel downloaded as described in
[README](../README.md). The secret is read interactively so it never appears
in a command line or shell history:

```powershell
$env:DINKSTER_FRONTEND_DIST = 'C:\PATH\TO\Dinkster-Frontend\packages\app\dist'
$env:DINKSTER_ENGINE_ARCHIVE = 'C:\PATH\TO\PINNED-BACKEND.zip'
$env:DINKSTER_AIMDO_WHEEL = 'C:\PATH\TO\PINNED-AIMDO.whl'
$env:AZURE_TENANT_ID = 'DIRECTORY-TENANT-ID'
$env:AZURE_CLIENT_ID = 'APPLICATION-CLIENT-ID'
$secret = Read-Host 'Signing client secret VALUE' -AsSecureString
try {
  $env:AZURE_CLIENT_SECRET = [System.Net.NetworkCredential]::new('', $secret).Password
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
  pnpm --filter @dinkster/desktop package:win:signed
  if ($LASTEXITCODE -ne 0) { throw 'Packaging or signing failed' }
  pnpm --filter @dinkster/desktop verify:update-feed
  if ($LASTEXITCODE -ne 0) { throw 'Update feed verification failed' }
} finally {
  Remove-Item Env:\AZURE_CLIENT_SECRET -ErrorAction SilentlyContinue
  Remove-Item Env:\AZURE_CLIENT_ID -ErrorAction SilentlyContinue
  Remove-Item Env:\AZURE_TENANT_ID -ErrorAction SilentlyContinue
  $secret.Dispose()
}
```

With `forceCodeSigning` on, any signing failure fails the build; do not switch
back to the unsigned configuration to get a release through. For a 403, check
that the identity validation is Completed, the profile is active, the endpoint
matches the account region, the account and profile names are exact, and the
Certificate Profile Signer role is on the app registration's service
principal. For an authentication failure, check that the secret Value (not its
ID) was used, that it has not expired, and that the tenant and client IDs
belong to the same registration.

### Verify the result

The release workflow runs this check before installing; run the same thing
after a local build:

```powershell
$files = @(
  Get-ChildItem packages/desktop/release -Filter '*-Setup.exe'
  Get-Item 'packages/desktop/release/win-unpacked/Dinkster Desktop.exe'
)
foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  $signature | Select-Object Path, Status, @{Name='Publisher'; Expression={$_.SignerCertificate.Subject}}, @{Name='Timestamp'; Expression={$_.TimeStamperCertificate.Subject}}
  if ($signature.Status -ne 'Valid' -or !$signature.TimeStamperCertificate) {
    throw "Invalid or untimestamped signature: $($file.Name)"
  }
}
```

Require **Valid**, the intended publisher, and a timestamp on both files. Then
install into a scratch directory, check the installed executable and generated
uninstaller the same way, and exercise first launch. A valid signature proves
the publisher and the file's integrity; SmartScreen reputation is earned
separately per publisher and can still warn on early downloads.

### Common identity validation problems

- `New identity` is dimmed: assign yourself Artifact Signing Identity Verifier
  on the account.
- The Individual form shows wrong name, address, or casing: the fields are
  imported read-only from the billing account's sold-to address. The portal
  cannot change casing; `az billing account update --sold-to ...` can (see
  the [FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq)).
  Updating the billing account can trigger a short account review and an
  email re-verification, and the portal's own address editor re-adds ZIP+4.
  Microsoft's documented failure reasons are content mismatches (address,
  name, FaceCheck), not letter case, so the casing fix is cosmetic: it only
  changes how the state appears in the certificate subject.
- Status stays Action Required after the ID scan: the scan only issued a
  Verified ID into Microsoft Authenticator. Reopen the verification link,
  scan the "Present your Verified ID" QR code from Authenticator's Verified
  IDs tab, and share it. Completed follows within minutes.
- "You don't have permission": the browser is signed in with a different
  account than the request's primary email. Use a private window with only
  that account.
- Address or name mismatch, FaceCheck failure: delete the request and the
  Verified ID in Authenticator, then submit a new request.

Microsoft routes identity validation questions to Microsoft Q&A or Stack
Overflow with the `artifact-signing` tag; requests cannot be expedited.

## macOS

### Enrollment

The Apple Developer Program enrollment is an Individual enrollment. If the
Apple Developer app cannot read the identity document during enrollment, Apple
offers [verification by another method](https://developer.apple.com/help/account/membership/identity-verification/)
through Developer Support: start at the [contact page](https://developer.apple.com/contact/)
signed in with the enrollment Apple Account, choose the membership topic, and
request a call; support calls are scheduled online, during US business hours.
Have the Enrollment ID, the exact error, and the device and app version ready.
Do not create a second Apple Account or a second enrollment.

Suggested request, filled in privately:

```text
I started an Individual Apple Developer Program enrollment with this Apple
Account. Enrollment ID: [ID]. The Apple Developer app's identity verification
fails at document capture with [exact error] for both passport and driver's
license. Please complete this existing enrollment using an alternative method
of identity verification. My goal is Developer ID Application signing and
notarization for a macOS app distributed outside the Mac App Store.
```

When membership is active, continue below rather than re-enrolling.

### Developer ID certificate

Follow Apple's [Developer ID certificate guide](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
as the Account Holder: Certificates -> `+` -> Developer ID Application. Create
the certificate signing request in Keychain Access on the Mac that will hold
the key, upload it, download the `.cer`, and import it into the same keychain.
Confirm with:

```sh
security find-identity -v -p codesigning
```

Expected: `Developer ID Application: LEGAL NAME (TEAMID)` with its private key.
A `.cer` without the key cannot sign. Move the identity between Macs only as a
password-protected `.p12` over a secure channel, never through Git.

### Build integration

There is no macOS packaging path yet: the engine packaging script requires the
pinned Windows runtime profile and Windows Aimdo wheel, and no macOS target,
entitlements, or notarization wiring exist. Account activation does not
produce a macOS build. When a macOS engine payload exists, the desktop
package's `build.mac` needs at least:

```json
{
  "mac": {
    "target": ["dmg", "zip"],
    "identity": "LEGAL NAME (TEAMID)",
    "hardenedRuntime": true,
    "forceCodeSigning": true,
    "notarize": true
  }
}
```

`identity` is the keychain name without the `Developer ID Application:`
prefix; the installed builder selects the certificate type itself and rejects
the prefix. `notarize: true` only takes effect when credentials are present,
so store them once in the build Mac's keychain:

```sh
xcrun notarytool store-credentials "dinkster-notary"
```

and set `APPLE_KEYCHAIN_PROFILE=dinkster-notary` for the packaging process.
Verify a build with `xcrun notarytool submit ... --wait`, `xcrun stapler
staple`, `codesign --verify --deep --strict`, and `spctl --assess --type
execute`, then install and launch the downloaded artifact on a clean Mac.

## Converting to Dinkster Inc later

Nothing above has to be redone when the company becomes the publisher; the
individual certificates keep working until replaced. Prerequisites for both
platforms: a D-U-N-S Number (free, request through Apple's
[D-U-N-S lookup](https://developer.apple.com/enroll/duns-lookup/)), a working
website on a company domain, and a mailbox on that domain.

- Apple: submit the [individual to organization migration request](https://developer.apple.com/contact/request/migrate-individual-account)
  for the existing team rather than enrolling a second time; the founder
  submits it, and Certificates, Identifiers & Profiles is unavailable while
  Apple processes it. Afterwards the team carries the organization name:
  create a new Developer ID Application certificate under that name, then
  rebuild and re-notarize.
- Windows: add an Organization identity validation on the same subscription
  (website, two addresses on the company domain, EIN as the business
  identifier, 1-20 business days), create a second certificate profile from
  it, and switch `artifactSigning` in `electron-builder.signed.mjs` to the new
  profile and common name. `acceptedUpdatePublishers` already lists the
  company, so existing installs accept the first company-signed update.
  SmartScreen reputation starts over for the new publisher.

## Completion evidence

Record redacted results, never credentials or documents:

- Windows: a signed package or release workflow run whose `Verify publisher
signatures` step passed, followed by a successful install and first launch
  of that installer.
- macOS: Developer Support confirms the enrollment is active; later, a
  notarized, stapled build passes Gatekeeper on a clean Mac.
