# Desktop signing

Draft instructions for distributing Dinkster Desktop with a verified publisher.
Provider documentation was checked on October 9, 2026. Account verification and
a successful signed build must still be confirmed by the account holder. Never
put identity documents, passwords, private keys, or client secrets in this
repository, support posts, build logs, or the installed application.

## What this build currently does

The build lives in [packages/desktop/package.json](../packages/desktop/package.json),
not in the backend or frontend repository. It uses Electron and electron-builder
**26.15.3**, resolved by [pnpm-lock.yaml](../pnpm-lock.yaml); the package's
`^26.0.12` dependency is not the installed version.

- Application identifier: `com.dinkster.desktop`.
- Product: `Dinkster Desktop`.
- Windows: x64 NSIS installer, `Dinkster-Desktop-${version}-Setup.exe`.
- `win.forceCodeSigning` is currently `false`. No Azure signing settings or
  Key Vault integration are configured. External certificate credentials could
  enable traditional signing, but the repository does not supply them.
- The [release workflow](../.github/workflows/release-desktop.yml) explicitly
  describes its output as unsigned. It has no signing credentials or signature
  validation step. Do not dispatch it to test these instructions.
- There is no macOS packaging script, target configuration, entitlement file,
  or notarization credential wiring. The engine packaging script requires the
  pinned Windows runtime profile and Windows Aimdo wheel. Apple enrollment can
  proceed, but a complete macOS product build is not established by this guide.

The Windows account holder has created an **Artifact Signing account named
`dinkster`**, with no subsequent setup completed. This is Microsoft's service
formerly called **Trusted Signing**, not an EV certificate stored in Key Vault.
Keep the existing account; do not buy a separate certificate or create a vault
for this path. The account name is not the certificate publisher's legal name.

## macOS: unblock Apple identity verification

### Reach the correct support channel

Apple explicitly says to [contact support for verification using a method other
than the Apple Developer app](https://developer.apple.com/help/account/membership/identity-verification/).
Use **Apple Developer Support for enrollment/membership**, not App Review,
Feedback Assistant, a code-level support request, or a public forum post with ID
documents.

1. Open [Apple Developer Support's contact page](https://developer.apple.com/contact/)
   in a browser and sign in with the **same Apple Account used for enrollment**.
2. Select the enrollment/membership topic and describe the identity-verification
   failure. The signed-in form's exact labels and available contact methods vary;
   they are not exposed by the public page. Do not create another Apple Account
   to try to bypass verification.
3. Request a support call if that option is offered, or submit the email/contact
   request. Apple confirms [phone and email support](https://developer.apple.com/support/)
   for membership and account questions. Its [telephone support page](https://developer.apple.com/support/worldwide-telephone-hours/)
   specifically says to **start the request online to receive a support call**.
   Use that route rather than an unverified phone number from search results.
4. Ask for an **alternative method of identity verification** for the existing
   enrollment. Apple decides the method and required evidence; support contact
   does not guarantee approval or a waiver of verification.

Have ready: enrollment Apple Account email, legal name and country/region,
individual versus organization enrollment, Enrollment ID if issued, prior case
number, exact error and when it occurred, device/app version if relevant, and
payment/order status. For an organization, also have its legal entity name,
D-U-N-S Number, and signing-authority details. Supply documents only through the
secure channel Apple directs you to use.

Suggested request, with brackets replaced privately:

```text
I started Apple Developer Program enrollment as [individual/organization]
using this Apple Account. Enrollment ID: [ID, or not issued].
The normal identity-verification flow fails at [step] with [exact error].
I have already tried [brief factual description]. Previous case: [if any].
Please help me complete this existing enrollment using an alternative method
of identity verification, as described in your identity-verification guidance.
My goal is Developer ID Application signing and notarization for a macOS app
distributed outside the Mac App Store. Please tell me the next required step
and the secure channel for any supporting documents.
```

Check the enrollment state at [your developer account](https://developer.apple.com/account/).
If verification is pending, resolve it before requesting certificates. If payment
was completed but membership confirmation did not arrive within 24 hours, Apple's
[enrollment instructions](https://developer.apple.com/help/account/membership/program-enrollment/)
say to contact support and include the Enrollment ID. If membership is active,
continue below rather than restarting enrollment.

### Obtain the Developer ID Application identity

After membership activation, follow Apple's [Developer ID certificate guide](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/):

1. As the **Account Holder**, open Certificates, Identifiers & Profiles ->
   Certificates -> `+` -> Software -> Developer ID.
2. Choose **Developer ID Application**, which signs the app. Developer ID
   Installer is for a signed `.pkg` installer, not a substitute for the app
   certificate. Apple Distribution/Mac App Store certificates are not this path.
3. On the Mac that will hold the signing key, use Keychain Access -> Certificate
   Assistant -> Request a Certificate From a Certificate Authority. Follow
   Apple's [CSR instructions](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request/)
   and save the CSR to disk. The private key remains on that Mac.
4. Upload the `.certSigningRequest`, continue, download the `.cer`, and
   double-click it to import it into the same Mac's keychain. Under My
   Certificates, confirm the certificate has its associated private key.
5. Record the Team ID and exact identity. On that Mac:

   ```sh
   security find-identity -v -p codesigning
   ```

   Expected: a valid `Developer ID Application: LEGAL NAME (TEAMID)` identity.
   Stop if it is absent, expired, or missing its private key. A downloaded `.cer`
   alone cannot sign. If a different build Mac needs the key, export/import the
   identity as a password-protected `.p12` through a secure channel, never Git.

### Connect signing and notarization to a macOS build

This is the required integration shape, **not an existing working macOS release
command**. First establish a macOS-compatible engine payload and packaging path;
do not reuse the pinned Windows wheel as a macOS runtime. In the desktop package's
`build` configuration, a Developer ID build needs settings such as:

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

Use the matching keychain identity's name **without the `Developer ID Application:`
prefix**. The locked builder selects that certificate type itself and
[rejects a prefixed qualifier](https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.15.3/packages/app-builder-lib/src/codeSign/macCodeSign.ts).
Review Electron/native-code entitlements for the real macOS payload before packaging. Do not use ad-hoc
identity `-`, `identity: null`, or disable hardened runtime to get a release
through notarization. The locked builder's [macOS signing implementation](https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.15.3/packages/app-builder-lib/src/mac/MacTargetHelper.ts)
uses credentials to activate notarization; **`notarize: true` alone can still
skip notarization when credentials are missing**.

For local notarization, install current Xcode and generate an
[app-specific password](https://support.apple.com/102654) for the enrollment
Apple Account. Store credentials interactively in the Mac's keychain rather
than putting the password on a command line:

```sh
xcrun notarytool store-credentials "dinkster-notary"
```

Enter the Apple Account, app-specific password, and Team ID when prompted.
Expected: credentials validate and are saved. Stop on authentication failure.
Set `APPLE_KEYCHAIN_PROFILE=dinkster-notary` in the macOS packaging process to
let electron-builder use that profile. Do not simultaneously provide a partial
`APPLE_ID`/password set; the builder checks those credentials before a profile.

For a signed distribution that needs manual notarization, Apple's
[command-line workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
uses `notarytool`, not deprecated `altool`:

```sh
xcrun notarytool submit "PATH/TO/DISTRIBUTION.dmg" --keychain-profile "dinkster-notary" --wait
xcrun notarytool log "SUBMISSION_ID" --keychain-profile "dinkster-notary" notarization-log.json
xcrun stapler staple "PATH/TO/DISTRIBUTION.dmg"
xcrun stapler validate "PATH/TO/DISTRIBUTION.dmg"
codesign --verify --deep --strict --verbose=2 "PATH/TO/Dinkster Desktop.app"
spctl --assess --type execute --verbose=4 "PATH/TO/Dinkster Desktop.app"
```

Replace paths and submission ID. Require status **Accepted**, inspect the log
even on success, require successful stapling/validation, and require Gatekeeper
acceptance with the intended Developer ID. Stop on Invalid, signature failures,
or rejection. ZIPs cannot be stapled directly: staple the app and rebuild the
ZIP. Test the final downloaded artifact's install and first launch on a clean
Mac; signing the Electron shell is not proof that its engine works.

## Windows: continue from the existing `dinkster` account

### Validate the publisher identity

Use Microsoft's [Artifact Signing quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
and [role assignment guide](https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles).
The portal uses Artifact Signing names; electron-builder retains Trusted Signing
terminology and `azureSignOptions`.

1. In [Azure portal](https://portal.azure.com/), search Artifact Signing Accounts
   and open **dinkster**. Record its subscription, resource group, tenant, and
   region. Check the subscription's Resource providers list shows
   `Microsoft.CodeSigning` as Registered. Do not recreate an existing account.
2. Under Access control (IAM) -> Add -> Add role assignment, assign your user
   **Artifact Signing Identity Verifier**. The user also needs at least Reader
   at subscription scope. Owner/Contributor alone do not grant identity
   validation or signing rights. If Add role assignment is unavailable, an
   administrator with role-assignment permission must make the assignment.
3. Choose the actual publisher type, not a brand name:
   - **Individual**: currently limited to US/Canada developers. The subscription's
     billing account must have Account Type **Individual**. Its legal name and
     sold-to address must match your government ID. Correct discrepancies in
     the billing account before submitting; the validation form's imported
     identity fields are read-only.
   - **Organization**: use the registered legal entity, business identifier,
     address, website and organization-domain contact emails. Check the
     quickstart's current supported countries. Organization validation does not
     require a billing account of type Organization.
4. Open Objects -> Identity validations. For an individual, change the
   Organization dropdown to Individual -> New Identity -> **Public**. Select
   the associated billing account and check Certificate subject preview. Use
   the same email for the verification request and the Microsoft Account used
   to open its verification link. For an organization, select Organization ->
   New Identity -> Public and provide the business information.
5. Create the request. When status is Action Required, open it and follow
   **Please complete your verification here**. Complete the partner ID checks
   reached from the portal link. The current individual walkthrough uses a
   mobile camera and **Microsoft Authenticator** to add a Verified ID and then
   present/share it with Artifact Signing. Keep the desktop browser open while
   scanning the QR codes. Do not send the documents to this repository or chat.
6. Require portal status **Completed**, not just success on the partner page.
   Organizations can require further business documents; the quickstart lists
   1-20 business days, possibly longer. Respond to Action Required requests and
   email links before they expire. Do not repeatedly submit duplicates to try
   to accelerate an in-progress request.

For inactive New Identity, check the Identity Verifier role. For failures,
follow the [Artifact Signing FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq)
for the specific error rather than deleting the signing account. Microsoft's
quickstart directs identity-validation questions to Microsoft Q&A or Stack
Overflow; post only a redacted status/error, never ID documents. Azure portal
support is available for other service setup problems.

### Create the Public Trust certificate profile

1. In dinkster -> Objects -> Certificate profiles -> Create, choose
   **Public Trust**, not Private Trust or Public Trust Test.
2. Name the profile, for example `dinksterdesktop`. Keep Program Type **None**.
3. For Verified CN and O, select the completed identity validation. Inspect the
   certificate subject preview and record the **exact CN** as the publisher
   name. An individual certificate identifies the legal person, not an
   arbitrary product brand. Review which address fields will be public.
4. Create the profile and confirm it is active. Record its name and the regional
   endpoint from the account. The region must match: East US uses
   `https://eus.codesigning.azure.net`; other regions have different endpoints
   listed in the quickstart. Do not select an endpoint based on your home
   timezone.

### Give the build its own signing identity

For an initial local Windows build, use an Entra app registration and a securely
supplied credential. This is separate from the publisher identity validation.
Microsoft [recommends certificates or federation over client secrets for
production](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials).
A short-lived secret is a straightforward first local test, not a reason to
embed credentials in the app or grant CI broad subscription permissions.

1. In the same tenant, follow [Register an application](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app):
   Entra ID -> App registrations -> New registration. Use a descriptive name
   such as `dinkster-desktop-signing`, single-tenant accounts, and no redirect
   URI for this noninteractive signing client. Register it.
2. Record Application (client) ID and Directory (tenant) ID from Overview.
3. Under Certificates & secrets -> Client secrets -> New client secret, choose
   a short lifetime and save its **Value**, not its Secret ID, in a password
   manager. It is shown only once. Do this privately, not in a shared transcript.
4. At the certificate profile's IAM scope, assign **Artifact Signing Certificate
   Profile Signer** to the app's service principal. Search for the registration
   name under user/group/service principal members. Grant at profile scope
   rather than subscription scope. Do not confuse the application's client ID
   with the service principal's object ID when assigning roles.
5. The build environment needs Node 22, pnpm 10.31.0 and Windows PowerShell or
   PowerShell 7, with network access to Azure and PowerShell Gallery. The locked
   builder installs the TrustedSigning module for CurrentUser and calls
   `Invoke-TrustedSigning`. It delegates authentication to that module; it does
   not acquire a GitHub OIDC token for you.

### Connect the profile to electron-builder 26

Once the endpoint, CN, and profile are known, merge these fields into the
existing **build.win** object in packages/desktop/package.json. Preserve icon,
NSIS target, artifactName, and other existing settings. This sample is not yet
configured in the repository:

```json
{
  "forceCodeSigning": true,
  "azureSignOptions": {
    "publisherName": "EXACT CERTIFICATE CN",
    "endpoint": "EXACT REGIONAL ENDPOINT",
    "codeSigningAccountName": "dinkster",
    "certificateProfileName": "dinksterdesktop",
    "fileDigest": "SHA256",
    "timestampDigest": "SHA256",
    "timestampRfc3161": "http://timestamp.acs.microsoft.com"
  }
}
```

Use the actual profile name if different. For this version, publisherName belongs
**inside azureSignOptions** and is the certificate CN, not the entire `CN=...`
subject string. The [locked-version implementation](https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.15.3/packages/app-builder-lib/src/codeSign/windowsSignAzureManager.ts)
and [options](https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.15.3/packages/app-builder-lib/src/options/winOptions.ts)
are the reference. Do not copy unreleased v27's `win.sign.type=azure` configuration.
Do not add signtoolOptions or CSC_LINK for this cloud signing path.

### Build locally without publishing

In a Windows PowerShell terminal at the desktop repository root, build the pinned
frontend as described in [README](../README.md) and obtain the pinned backend ZIP
and Aimdo wheel from their official repository releases. Keep those artifacts
outside packages/desktop/resources/engine; preparation verifies the pinned sizes
and SHA-256 digests. Replace the paths and IDs below. Do not paste a secret into
a command, print environment variables, or use DEBUG logging with credentials.

```powershell
$env:DINKSTER_FRONTEND_DIST = 'C:\PATH\TO\PINNED-FRONTEND\packages\app\dist'
$env:DINKSTER_ENGINE_ARCHIVE = 'C:\PATH\TO\PINNED-BACKEND.zip'
$env:DINKSTER_AIMDO_WHEEL = 'C:\PATH\TO\PINNED-AIMDO.whl'
$env:AZURE_TENANT_ID = 'DIRECTORY-TENANT-ID'
$env:AZURE_CLIENT_ID = 'APPLICATION-CLIENT-ID'
$secret = Read-Host 'Signing client secret VALUE' -AsSecureString
try {
  $env:AZURE_CLIENT_SECRET = [System.Net.NetworkCredential]::new('', $secret).Password
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
  pnpm --filter @dinkster/desktop package:win
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

Expected: a successful package build with Azure signing, a generated Setup.exe,
and passing update-feed verification. Stop on any error; do not disable signing
to continue. For 403, check completed validation, active profile, regional
endpoint, exact account/profile names, and the **service principal's** Profile
Signer role. Allow a recent role assignment time to propagate. For authentication
failure, check secret Value versus ID, expiration, tenant and client ID.

### Verify signatures, then test installation

From the same repository root on Windows:

```powershell
$files = @(
  Get-ChildItem 'packages/desktop/release' -Filter '*-Setup.exe'
  Get-Item 'packages/desktop/release/win-unpacked/Dinkster Desktop.exe'
)
if ($files.Count -ne 2) { throw 'Expected one installer and one app executable' }
foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  $signature | Select-Object Path, Status, @{Name='Publisher'; Expression={$_.SignerCertificate.Subject}}, @{Name='Timestamp'; Expression={$_.TimeStamperCertificate.Subject}}
  if ($signature.Status -ne 'Valid' -or !$signature.TimeStamperCertificate) {
    throw "Invalid or untimestamped signature: $($file.Name)"
  }
}
```

Require **Valid**, the intended legal publisher, and a timestamp on both files.
Install the resulting installer into an isolated test directory and check the
installed app and generated uninstaller with Get-AuthenticodeSignature too.
Then exercise first launch and engine setup. A build exit code alone is not
proof of a valid signed installer. Signing identifies the publisher and protects
integrity; it is not a guarantee that SmartScreen will never show a warning.

Before any future release integration, the account holder must arrange secure
credential delivery to the Windows signing job, restrict its profile access,
add these signature checks before checksum generation/publication, and replace
the unsigned release description only after signing is verified. Secret changes
and release publication are user actions, not part of this documentation test.

## Completion evidence

Keep this guide and its pull request draft until the account holder confirms:

- Apple's alternative-verification support request resolved the actual blocked
  enrollment state, and the Developer ID Application identity is usable.
- Artifact Signing identity validation is Completed and the Public Trust profile
  is active, with the actual region/profile/CN reflected in build configuration.
- A locally produced Windows installer, app and uninstaller have valid intended
  publisher signatures and timestamps, and install/first launch succeed.
- A macOS-compatible build has been established, signed with Developer ID,
  notarized, stapled, and verified on a Mac. Account approval alone is not this
  result.

Do not report either platform as signed based only on these instructions or the
existence of an account. Record redacted verification results, not credentials
or identity documents.
