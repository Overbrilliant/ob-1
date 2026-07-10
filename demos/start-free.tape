# demos/start-free.tape — records the REAL first-run "Start free" flow (no faked output).
#
# Prereqs (full procedure in demos/README.md):
#   export OB1_DEMO_HOME="$(mktemp -d)"      # pristine settings dir for the take
#   export OB1_DEMO_PROJECT="$(mktemp -d)"   # empty demo workspace
#   vhs demos/start-free.tape                # first run is SLOW (real npm install of FreeLLMAPI)
#   # then reset state but keep the warm clone, and re-run for the short final take:
#   rm -f "$OB1_DEMO_HOME/settings.json" "$OB1_DEMO_HOME/freellm.json" "$OB1_DEMO_HOME/onboarded"
#   rm -rf "$OB1_DEMO_HOME/freellmapi/data" "$OB1_DEMO_HOME/freellmapi/server/data"
#   vhs demos/start-free.tape
#
# Gotchas learned the hard way:
# - Use Sleep-based timing only: VHS 0.11's Wait+Screen/Screenshot abort this recording.
# - unset OB1_SERVER (dev overrides) or the CLI routes to a local server and skips onboarding.
# - The flow opens the FreeLLMAPI dashboard in your default browser mid-take; that's real behavior.
# - Kill the leftover proxy after recording: pkill -f "server/dist/index.js"
# - Re-render at release so the banner shows the shipped version.

Output docs/media/start-free.gif
Set Shell "bash"
Set FontSize 14
Set Width 920
Set Height 500
Set Padding 12
Set TypingSpeed 70ms

Hide
Type `export OB1_SETTINGS_DIR="$OB1_DEMO_HOME"; unset OB1_SERVER OPENROUTER_API_KEY OPENAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY GROQ_API_KEY OB1_BASE_URL OB1_API_KEY OB1_TOKEN; cd "$OB1_DEMO_PROJECT"; clear`
Enter
Show

Sleep 800ms
Type "ob1"
Sleep 600ms
Enter
# banner + picker render; "Start free" is the default selection
Sleep 8s
Enter
# real provisioning: clone/pull, generated dashboard login, launch, connect (warm cache ≈ 10-14s)
Sleep 14s
Enter
# "No provider key added yet — free anonymous models still work" → TUI boots
Sleep 12s
