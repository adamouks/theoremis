Download the installer for your computer below, or from https://theoremis.vercel.app.

| | |
| --- | --- |
| **macOS** (Apple silicon) | `Theoremis_*_aarch64.dmg` |
| **macOS** (Intel) | `Theoremis_*_x64.dmg` |
| **Windows** | `Theoremis_*_x64-setup.exe` |
| **Linux** | `.AppImage`, `.deb` or `.rpm` |

These builds aren't notarized by Apple or signed for Windows yet, so the first launch needs one extra step:

- **macOS:** open the app once, then go to System Settings → Privacy & Security and choose **Open Anyway**. Or run `xattr -dr com.apple.quarantine /Applications/Theoremis.app`.
- **Windows:** if SmartScreen appears, choose **More info → Run anyway**.
- **Linux:** make the AppImage executable with `chmod +x Theoremis_*.AppImage`.

Then sign in with ChatGPT in Settings to use your plan, or point Theoremis at a local Ollama server.
