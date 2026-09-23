# Read Aloud

An [Orca](https://github.com/stablyai/orca) plugin that talks when an agent finishes a turn.

You keep working. When the turn ends, Claude writes two to four sentences worth hearing, and the Mac voice reads them. Fenced code is left out. If the microphone is on, including an unmuted call, it stays quiet and does not catch up later.

The voice is local. `say` uses whatever voice you picked in System Settings, Spoken Content. The words come from the `claude` command already logged in on your Mac, on your Claude subscription. No API key is pulled out of the environment. If Claude fails or takes more than 25 seconds, the Mac voice reads a plain extract of the reply instead.

It follows Grok, Claude Code, and Codex by reading their transcript files on disk.

## Install

Orca 1.4 or newer, on a Mac. You also need the `claude` CLI, logged in.

```sh
git clone https://github.com/dropoutsanta/orca-read-aloud.git
cd orca-read-aloud
./build.sh
```

In Orca, open Settings, then Plugins. Turn the plugin system on. Under Development, add the folder you just cloned. When Orca asks you to review it, click Enable plugin.

On stock Orca, the live board is at http://127.0.0.1:47321, because the stock sidebar cannot receive plugin updates.

On the `sidebar-channel` fork of Orca, the same board is the Read Aloud sidebar. The fork adds one channel: a plugin can publish status to its own panel, and that panel can run that plugin's own commands. The fork also tells the plugin each tab's title and the reply that tab just gave, so the sidebar uses your tab names and the voice always reads the tab that finished. `scripts/rebase-upstream.sh` in that fork rebases those commits onto Orca's main and stops, naming the files, when the rebase conflicts.

## The board

The sidebar lists one row per agent tab that was active in the last 45 minutes. Each row shows the agent, how long it has been working, and what Read Aloud last said for it. Working covers the whole turn, including while the model is thinking.

Mute is per tab and takes effect on click, including mid-sentence. Off stops everything. Stop cuts the current voice.

Option-Command-X also stops it, including while a terminal has focus. Orca does not deliver plugin shortcuts into a terminal, so `stop-hotkey` registers that chord with macOS.

## What gets built

`build.sh` compiles two small Swift tools:

- `mic-in-use` checks whether the default input device is running. That is the orange microphone indicator.
- `stop-hotkey` listens for Option-Command-X.

## License

MIT. Use it, change it, ship it.
