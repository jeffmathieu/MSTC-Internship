# Code signing the installers

The release workflow (`.github/workflows/release.yml`) signs the Windows and
macOS builds **as soon as the matching GitHub secrets exist**. Without them it
still builds, unsigned, exactly like before, and prints a warning in the run.

| Without signing | With signing |
| --- | --- |
| Windows SmartScreen: "Windows protected your PC" | Installer shows the publisher name; SmartScreen warnings fade as the app gains reputation |
| macOS: "cannot be opened because the developer cannot be verified" | Opens normally (signed **and** notarized) |
| macOS auto-updates download but cannot install | macOS auto-updates install like on Windows |

Certificates cost money and are tied to a person or company, so they have to be
bought by the owner of the app. Everything else is already set up.

Add secrets under **GitHub → repository → Settings → Secrets and variables →
Actions → New repository secret**. Never commit certificates, passwords or keys
to the repository.

## macOS: Developer ID + notarization

1. Join the **Apple Developer Program** (developer.apple.com, about €99 per year).
2. On a Mac, in Xcode → Settings → Accounts → Manage Certificates, add a
   **Developer ID Application** certificate (only the account holder can create
   one). Export it from Keychain Access as a `.p12` file with a password.
3. Turn the file into text for GitHub:
   ```bash
   base64 -i DeveloperID.p12 | pbcopy
   ```
4. Add the secrets:

   | Secret | Value |
   | --- | --- |
   | `MAC_CERTIFICATE` | the base64 text of the `.p12` |
   | `MAC_CERTIFICATE_PASSWORD` | the `.p12` password |

5. Notarization (Apple checks the app for malware; required for Gatekeeper).
   Pick **one** of the two:

   **Apple ID** (simplest)

   | Secret | Value |
   | --- | --- |
   | `APPLE_ID` | the Apple ID e-mail of the developer account |
   | `APPLE_APP_SPECIFIC_PASSWORD` | an app-specific password from account.apple.com → Sign-In and Security |
   | `APPLE_TEAM_ID` | the 10-character Team ID (developer.apple.com → Membership) |

   **App Store Connect API key** (does not break when the Apple ID password changes)

   | Secret | Value |
   | --- | --- |
   | `APPLE_API_KEY_BASE64` | `base64 -i AuthKey_XXXX.p8` of the downloaded key |
   | `APPLE_API_KEY_ID` | the key ID |
   | `APPLE_API_ISSUER` | the issuer ID shown above the keys list |

The app is built with the hardened runtime and the entitlements in
`docs/mstc_app_icons/electron-builder/build/entitlements.mac.plist`, which
notarization requires.

## Windows

Pick **one** of the two.

### Azure Trusted Signing (cheapest, about €10 per month)

Microsoft's signing service. The key lives in Azure, so there is no
certificate file or USB token. Check that your company (or you as an
individual) is eligible in your country before you start.

1. In the Azure portal create a **Trusted Signing account**, complete the
   identity validation and create a **Public Trust** certificate profile.
2. Create an app registration (service principal) with a client secret and give
   it the **Trusted Signing Certificate Profile Signer** role on the account.
3. Add the secrets:

   | Secret | Value |
   | --- | --- |
   | `AZURE_TENANT_ID` | directory (tenant) ID |
   | `AZURE_CLIENT_ID` | application (client) ID |
   | `AZURE_CLIENT_SECRET` | client secret |
   | `AZURE_SIGNING_ENDPOINT` | e.g. `https://weu.codesigning.azure.net/` |
   | `AZURE_SIGNING_ACCOUNT` | the Trusted Signing account name |
   | `AZURE_CERTIFICATE_PROFILE` | the certificate profile name |
   | `AZURE_PUBLISHER_NAME` | the subject name on the certificate (the validated name, e.g. `Jeff Mathieu`) |

### A code signing certificate file (.pfx)

Only if your certificate authority gives you an exportable `.pfx` file (most new
certificates are delivered on a USB token or in a cloud vault, which this
option cannot use).

| Secret | Value |
| --- | --- |
| `WINDOWS_CERTIFICATE` | `base64` text of the `.pfx` file |
| `WINDOWS_CERTIFICATE_PASSWORD` | its password |

## After the first signed release

* The **Check the signatures** step of the release run shows who signed each
  file. On macOS it also runs Gatekeeper's check (`spctl`).
* **Windows** users keep updating automatically.
* **macOS** users on an older, unsigned version cannot install the signed update
  automatically. The app then shows *"Update could not be installed"* with a
  button to the release page: download it once and drag it into Applications.
  From then on, macOS updates install automatically.
* SmartScreen builds up trust per publisher. The first signed releases can
  still show a (milder) warning for a while; that is normal.
