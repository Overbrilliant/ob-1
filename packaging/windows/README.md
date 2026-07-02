# Windows Package Manager Investigation

Windows packaging is intentionally not publishable yet. The release workflow currently builds macOS and
Linux archives. Add Windows only after `ob1-windows-x64.zip` is produced, signed where appropriate, and
tested on a clean Windows runner.

## winget

Use a versioned manifest once the Windows asset exists:

```yaml
PackageIdentifier: Overbrilliant.OB1
PackageVersion: 0.1.3
PackageLocale: en-US
Publisher: Overbrilliant
PackageName: OB-1
License: Apache-2.0
ShortDescription: Free open-source CLI coding agent.
Installers:
  - Architecture: x64
    InstallerType: zip
    InstallerUrl: https://github.com/Overbrilliant/ob-1/releases/download/v0.1.3/ob1-windows-x64.zip
    InstallerSha256: PUT_RELEASE_SHA256_HERE
ManifestType: singleton
ManifestVersion: 1.10.0
```

Validation:

```powershell
winget validate .\manifests\o\Overbrilliant\OB1\0.1.3\
winget install --manifest .\manifests\o\Overbrilliant\OB1\0.1.3\
ob1 --version
```

## Scoop

Use a bucket manifest once the Windows asset exists:

```json
{
  "version": "0.1.3",
  "description": "OB-1, the free open-source CLI coding agent.",
  "homepage": "https://github.com/Overbrilliant/ob-1",
  "license": "Apache-2.0",
  "architecture": {
    "64bit": {
      "url": "https://github.com/Overbrilliant/ob-1/releases/download/v0.1.3/ob1-windows-x64.zip",
      "hash": "PUT_RELEASE_SHA256_HERE"
    }
  },
  "bin": "ob1.exe",
  "checkver": {
    "github": "https://github.com/Overbrilliant/ob-1"
  },
  "autoupdate": {
    "architecture": {
      "64bit": {
        "url": "https://github.com/Overbrilliant/ob-1/releases/download/v$version/ob1-windows-x64.zip"
      }
    }
  }
}
```

Validation:

```powershell
scoop install .\ob1.json
ob1 --help
```
