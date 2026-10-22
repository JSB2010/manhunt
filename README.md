# Manhunt Crews

**Manhunt for friends, played across a town with iPhones.** Two or three crews take turns hiding. While one crew hides, the others hunt it down. The seekers never see where the hiders actually are. They get a location **ping** on a schedule, for example every 10 minutes. They close in, take a photo of the hiders, and the hiders confirm the catch. Then another crew hides.

> *Manhunt Crews* is a working name, not a cleared App Store name. The app is in private testing on TestFlight.

## How a night works

1. **Make a night.** Someone taps **Create a Night**, names the crews (2 or 3) and lists who's on each. Friends without the app are just names on a roster.
2. **Join with the night code.** Every crew needs at least one iPhone running the app, and can have up to five. Phones join with the night code and pick a crew.
3. **Ready up.** Each phone agrees to round tracking once. Then every crew taps **Ready** and any phone starts the round.
4. **Head start.** The hiding crew gets a head start (10 minutes by default) to get away. The seekers wait.
5. **Chase.** When the head start ends, the seekers get the first ping: where the hiders were *at that moment*. Another ping follows every interval (10 minutes by default). Between pings the seekers are on their own.
6. **Catch.** When they find the hiders, a seeker taps **Photo Catch** and takes a picture. The clock freezes while the hiding crew reviews it on their own phone and confirms or rejects it.
7. **Next round.** Every phone sees the recap: chase time, both crews' routes and distances, and the pings. Any phone can set up the next round, and the app suggests the crew that has hidden least. Play as many rounds as you like, then **End Night**. The night summary shows how long each crew lasted while hiding.

The full player guide, with roles, pauses, phone status and the Lock Screen, is in **[docs/how-to-play.md](docs/how-to-play.md)**.

## What makes it fair

- **Seekers only ever get the scheduled pings.** The hiders' live route, latest position and upcoming positions never reach a seeker's phone. The server and the database rules enforce this, not just the screen. Hosting or organizing the night gives no extra access.
- **The server keeps time.** Head starts, pings, catch reviews and pauses run on the server's clock. Changing a phone's clock, locking it or losing notifications can't change the game.
- **Honest pings.** A ping uses a recent, accurate GPS fix from one of the hiding crew's phones. If none has arrived yet, the ping *waits* and goes out, marked late, with where the hiders are **now**. It never reveals an old backlog and never invents a position.
- **Crew scores, not individual ones.** Every time and distance belongs to a crew. A single round has no winner. A night only names the stronger hiding crew when the rounds were actually comparable.
- **Your data, your call.** Raw GPS is deleted after 30 days. Routes are only shown after a round, and only if every phone agreed. You can delete your data from a night, or your whole account, at any time. See the [privacy policy source](hosting/public/privacy.html).

## On a locked phone

During a round the phone is usually locked in a pocket or mounted in a car. The round shows as a **Live Activity** on the Lock Screen, in the Dynamic Island, on the Apple Watch Smart Stack and on CarPlay. It shows the phase, the clock and when the next ping goes out. It never shows a location. GPS keeps recording in the background, and notifications cover the moments that need you: the chase starting, a ping going out, a catch to review.

## What you need

| To… | You need |
|---|---|
| Play on TestFlight | An iPhone on iOS 18 or later, an invite to the TestFlight build, and Location set to *While Using the App* with Precise Location on |
| Run it locally | A Mac with Xcode 27, Node 24, Java 21 and the Firebase CLI. No cloud account needed |
| Run it on your own iPhones | The above, plus a free Apple Personal Team. Push notifications and Sign in with Apple need the paid Apple Developer Program |
| Host your own backend | A dedicated Firebase project on the Blaze (pay-as-you-go) plan |

## Quick start for developers

Everything runs locally against the Firebase emulators, using the `demo-manhunt` project. Nothing can touch a real project.

```bash
cd backend && npm ci && cd ..
scripts/dev.sh
```

`dev.sh` starts the emulators, the API on `:8787` and the local worker on `:8788`. Then seed the demo accounts from a second terminal:

```bash
cd backend && npm run seed:emulator
```

Open `ios/ManhuntCrews.xcodeproj`, choose an iPhone simulator and Run. Sign in with an account from `backend/scripts/seed-accounts.json`. To play both sides, run a second simulator, or let the scripted two-phone round do it:

```bash
scripts/e2e-two-simulators.sh "iPhone 16 Pro Max" "iPhone 16e"
```

The [developer guide](docs/development.md) covers setup, tests, physical iPhones, design-QA fixtures and troubleshooting.

## Documentation

| | |
|---|---|
| [How to play](docs/how-to-play.md) | The player guide |
| [Developer guide](docs/development.md) | Setup, running, testing, common changes, troubleshooting |
| [Architecture](docs/architecture.md) | How the app, the API, the worker and Firestore fit together |
| [Data model](docs/data-model.md) · [API](docs/api.md) | Firestore and Storage layout; REST conventions and routes |
| [Privacy & threat model](docs/permissions-threat-model.md) · [Scoring & retention](docs/scoring-and-privacy.md) | What's protected and how; how times, distances and scores are defined |
| [Deployment](docs/deployment.md) · [Production release](docs/release-prod.md) · [iOS signing](docs/apple-distribution.md) | Backend deploys, TestFlight releases, device builds |
| [Test matrix](docs/test-matrix.md) | What's tested where, latest results, the physical-device checklist |
| [Design system](docs/design-system.md) | The iOS design: HIG, Liquid Glass, colour, accessibility |
| [Decisions (ADRs)](docs/adr/README.md) · [Original spec](docs/product-spec.md) · [Glossary](docs/glossary.md) | Why it is the way it is |
| [AGENTS.md](AGENTS.md) | Rules and workflow for AI coding agents and contributors |

All the docs are listed in [docs/README.md](docs/README.md).

## Repository layout

```
ios/            SwiftUI app, Live Activity widget extension, unit + UI tests
backend/        Node 24 + TypeScript: game core, API, Cloud Functions entry, tests
shared/         OpenAPI contract and the Live Activity fixture shared by app and server
hosting/        Privacy policy and support pages (Firebase Hosting)
scripts/        Local stack, two-simulator E2E, project setup, deploy, iOS signing and release
docs/           Guides, architecture, runbooks, ADRs
firebase.json, firestore.rules, firestore.indexes.json, storage.rules   Firebase config
```

## Deploying

Nothing in this repo deploys on its own. Deploys and anything billed need a dedicated Firebase project on Blaze, and your approval. Start with [docs/deployment.md](docs/deployment.md) for the backend and [docs/release-prod.md](docs/release-prod.md) for TestFlight. The deploy and setup scripts refuse project ids without "manhunt" in them and ask you to type the id before they do anything.
