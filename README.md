# Linq Codex Quickstart

This repo contains a Codex skill that sets up a local Linq-to-Codex text message demo.

The idea is simple: you text your Linq sandbox number, Linq sends a webhook to a small local Node server, the server asks local Codex to answer, and the reply goes back to the same Linq conversation.

The skill is meant to do the whole setup in one pass. It opens the Linq sandbox dashboard in Chrome, finds the sandbox send-from number, asks for your phone number if you did not provide it, writes the local bridge server, starts a public tunnel, creates the Linq webhook subscription, saves the signing secret, and validates that the public webhook rejects unsigned requests.

To use it from Codex after installing the skill:

```text
Use $linq-codex-quickstart with my phone number +1XXXXXXXXXX.
```

Your phone number must use `+1` plus the 10-digit US number. The skill stops and asks for it if it is missing, because that number is used both as the first test recipient and as the allowed sender for inbound SMS replies.

The generated bridge uses your existing local Codex login through `codex exec`; it does not ask for an OpenAI API key. Linq credentials are saved only in the generated local `.env.local`.
