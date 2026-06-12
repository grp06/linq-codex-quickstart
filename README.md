# Linq Codex Quickstart

This repo contains a Codex skill that sets up a local Linq-to-Codex text message demo.

The idea is simple: you text your Linq sandbox number, Linq sends a webhook to a small local Node server, the server asks local Codex to answer, and the reply goes back to the same Linq conversation.

The skill is meant to do the whole setup in one pass. It opens the Linq sandbox dashboard in the Codex in-app Browser, finds the sandbox send-from number, reveals the sandbox API key with the little eye icon if it is hidden, asks for your phone number if you did not provide it, writes the local bridge server, starts a public tunnel, creates the Linq webhook subscription, saves the signing secret, and validates that the public webhook rejects unsigned requests.

If you are not logged in to Linq, the skill pauses and leaves the sandbox page open in the Codex in-app Browser so you can log in there. After that, you can ask Codex to continue.

To use it from Codex after installing the skill:

```text
Use $linq-codex-quickstart with my phone number +1XXXXXXXXXX.
```

You can provide your phone number as `+13215550123`, `321-555-0123`, or another ordinary US format. The skill normalizes it to `+1XXXXXXXXXX` and uses that number as both the first test recipient and the allowed sender for inbound SMS replies.

The generated bridge uses your existing local Codex login through `codex exec`; it does not ask for an OpenAI API key. Linq credentials are saved only in the generated local `.env.local`.
