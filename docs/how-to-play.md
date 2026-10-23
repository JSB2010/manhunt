# How to play Manhunt Crews

Manhunt Crews is hide-and-seek across a neighbourhood or a town, played in crews. This guide covers a night from start to finish and what the app does at each step. For the privacy details, see the [privacy policy source](../hosting/public/privacy.html).

## The basics

| Term | Meaning |
|---|---|
| **Night** | One evening of play, with a night code, crews and as many rounds as you want |
| **Crew** | A group that moves together, named after its people ("Sasha & Marco", "Sasha, Marco & 2 more"). A night has two or three, shown in blue, orange and green. Crews can change between rounds |
| **People** | Everyone in the night, with or without the app. Each person is on one crew or **sitting out** |
| **Sitting out** | In the night but not playing the next round: taking a break, or not here yet. Their phone stays connected but isn't tracked |
| **Phone** | An iPhone running the app. It belongs to the person carrying it and plays on that person's crew. A crew needs at least one phone, and can have up to five. All of a crew's phones are equal |
| **Round** | One crew hides, and every other crew seeks |
| **Head start** | Time the hiders get before the seekers set off. 10 minutes by default |
| **Ping** | The hiders' position at a scheduled moment, sent to the seekers. The first goes out when the head start ends, then one every interval (10 minutes by default) |
| **Catch** | A seeker's photo of the hiders, which the hiding crew confirms |

The app tracks the **phones**, and each phone stands in for its crew. Keep each crew together. The app measures the route of the crew's best-tracked phone, not each person.

## Before the night

- **Install** the app from your TestFlight invite and create an account (email and password).
- **Location:** when asked, choose *Allow While Using App* and keep **Precise Location** on. The app records location only during rounds you take part in, including while the phone is locked.
- **Notifications:** turn them on. Notifications tell you when the chase starts, a ping goes out or a catch needs review.
- **Low Power Mode** can delay background GPS. Keep it off on the hiders' phones if you can.
- **Seekers in a car:** only a passenger uses the app, never the driver. Follow traffic laws.

## 1. Set up the night

On **Play**, tap **Create a Night**:

- Give the night a name and choose **2 Crews** or **3 Crews**.
- Add people to each crew: type a name, or tap the people button for saved people and groups. Put anyone who isn't here yet under **Sitting Out**. **Shuffle Crews** makes random, even crews. Crews are named after their people, so there's nothing to name.
- Drag people between crews, or tap **•••** next to someone to move them. Your phone plays on whichever crew you're on.
- Set the rules in **Crews & Rules** (you can change them between rounds):

| Rule | Default | Range |
|---|---|---|
| Head start | 10 min | 0–60 min |
| Ping interval | 10 min | 1–60 min |
| Pins the seekers can see | the latest 1 | 1–50, or all |
| Chase time limit | off | 5 min – 6 h |
| Time for the hiders to review a catch | 2 min | 30 s – 10 min |
| Manual pauses (both sides agree) | on | on/off |
| Ping accuracy: max GPS age | 60 s | 10–300 s |
| Ping accuracy: max error | 50 m | 5–200 m |

A ping only uses a GPS fix that meets the last two rules. If none does, the ping waits (see below).

## 2. Join

Every phone that plays needs to join the night:

- The night code is on **Night Code** in the lobby, and anyone on the night can show it. It works for every crew until the night ends. **New Code** replaces it, and the old code stops working.
- Others tap **Join with a Code** (or open the shared link), check the night under **Review & Join**, and pick their crew. Under **Who Are You?** they pick the name the organizer typed for them (the app suggests one), so their rounds count for them and nobody is listed twice; **Not listed — add me** adds their own name. Picking a name picks that name's crew, and otherwise the app suggests the crew with the fewest phones. Someone sitting out who joins has arrived: they go on the crew they pick.
- You can also invite a friend directly from your friends list.

## 3. Ready and start

- Once per night, each phone taps **Review Tracking**, reads how tracking works and taps **I Agree**. Agreeing includes showing every crew's route to the round's phones after each round.
- Each crew taps **We're Ready**. One ready phone per crew is enough: once it shows **Crew Ready**, the whole crew is ready, and tapping it again asks before undoing it.
- People sitting out don't play the round: no Ready, no tracking, no pins. Their phone shows **You're sitting out this round** and **Join a Crew**.
- Any phone on a playing crew can then tap **Start Round**. The app warns first (**Can't Start Cleanly**) if a phone has location turned off, which must be fixed, or a weak or old GPS fix, which you can start anyway.

## 4. Head start

The hiding crew sets off. The big clock counts the head start down on every phone, and the seekers wait. Hiders can lock their phones and put them away: tracking keeps going in the background.

## 5. Chase

When the head start ends, the seekers are off, and the first ping lands on their map.

- **Pins** are diamonds numbered by ping, in the hiding crew's colour. The newest is the largest. **Directions** opens Apple Maps to a pin.
- The next ping goes out every interval. The HUD shows **Next ping in …**.
- **Waiting pings.** If none of the hiders' phones has a good fix on the server at ping time (a dead zone, a tunnel), the ping *waits*. The hiders get "Seekers are waiting on your ping". As soon as a fix gets through, the seekers get the hiders' **current** position, marked late. An old position is never revealed after the fact, and the schedule doesn't shift.
- **With two seeking crews**, choose before the round:
  - **Together:** a catch counts for both seeking crews.
  - **Race:** it counts only for the crew that made it, and only that crew and the hiders see its photo.
- **Phone Status** shows what's wrong with tracking on your crew's phones. Other crews only see a summary, such as "2 of 2 live".

## 6. Catch

- When you find the hiders, tap **Photo Catch**, take the photo and submit it. The official catch time is the moment you **submit**.
- The clock freezes, and every hiding-crew phone gets the claim. One of them taps **Confirm Catch**, or rejects the claim.
- Rejected, or not answered in time: the clock runs again from where it froze, and pings carry on. Nothing from the frozen period is ever revealed.
- Disagreements can be settled after the round. A claim counts as a catch only when the hiders and the claiming crew both accept it.
- Photos lose their location and camera metadata on the server. Photos may show bystanders, so be considerate.

## Pauses, safety and stopping

Open **Round Options** (the menu button on the game screen):

- **Request Pause…:** one side asks, and a phone on the other side accepts within 90 seconds. Seekers can't freeze the hiders on their own, and the other way round.
- **Safety Pause Now:** freezes the round at once, from any phone, and alerts everyone.
- **Resume:** needs one tap from the hiders and one from the seekers.
- **Stop Tracking This Phone:** stops this phone's GPS and pauses for safety, so everyone knows.
- **Abort Round:** ends the round without a result. Aborted rounds don't count in comparisons.
- **Hide Live Activity:** removes the round from this phone's Lock Screen.

The clock and the ping schedule stop during every pause and pick up where they left off.

## On a locked phone

The round shows as a **Live Activity** on the Lock Screen and in the Dynamic Island, and on an Apple Watch or CarPlay. It shows the phase, the clock, the next ping and your crew's colour ("Blue crew"), and never a location or anyone's name. Tap it to open the game. Turn it off in **Account & Settings › Show Rounds on Lock Screen**.

## 7. After the round

- **Round recap:** the chase time (or "survived" if the time limit ran out), each crew's route and distances, and the list of pings with how fresh each fix was.
  - Routes appear only after the round, only to the phones that played it, and only if every phone agreed.
  - Distances are per crew: the hiders on foot for the whole round and for the chase, and each seeking crew for the chase.
- **Next round:** any phone taps **Next: Round N**. The app suggests the crew that has hidden least, and **Someone Else Hides…** picks another.
- **Between rounds:** any phone in the night, including one sitting out, can open **Crews & Rules…** to add or remove a crew, change the rules, and move people. Drag people between crews and **Sitting Out**, or tap **•••** next to someone:
  - **Move to** another crew. Their phone goes with them, so the rounds they play count for their new crew.
  - **Sit Out** for a round or more. Their phone stays in the night and isn't tracked.
  - **Take Their Phone Out** if their battery died: they keep playing as a name.
  - **Remove** if they went home. Their phone leaves the night too. The organizer can sit out but can't be removed.
  - Add someone who just arrived by typing their name, or they join with the code.
  - Removing a crew puts its people with the other crews.
  - A phone that joins mid-round watches until the next round.
- **End Night:** any phone can end the night, and the night code stops working.

## Scores

There's no winner of a single round. The **Night Summary & Scorecard** compares how long each crew survived while hiding:

- Crews change during a night, so crews are compared within a **matchup**: the rounds played by the same people on each crew, under the same rules. A night with one set of crews is one matchup.
- A matchup names the crew that **lasted longest while hiding** only if the comparison is fair: every crew hid equally often, and no round was aborted or ran out of time. Otherwise it shows a **Provisional Comparison** and says why.
- **People** lists everyone with their crews' results: how often they hid and sought, how long their crew lasted while they hid, and the catches it made while they sought.
- **Rounds** lists who hid in each round, and what changed before it: who joined, left or moved, and which rules changed.
- **Export CSV / Export JSON** saves the results. Exports never include GPS.

People's stats on the **People** tab are always their *crew's* results in the rounds they played, never an individual time.

## Friends, people and groups

- **Friends:** share your friend link (**Share My Friend Link**) or send a request by @handle. Friends can invite you to nights directly. Being friends never shares your location.
- **People:** saved names for people you play with, with or without the app. If someone saved you as a name, **This Is Me — Request Account Link** asks them to link it to your account. Duplicates can be merged.
- **Groups:** your usual players, for quicker setup.

## Your data

- **Raw GPS** is deleted automatically after 30 days. Simplified routes and stats stay until the night is deleted.
- **Catch photos** are deleted after 7 days if not confirmed, and after 30 days if confirmed, unless every crew chooses to keep them.
- **Delete My Data** (History › the night) removes this phone's tracks, the pings that came from it and the photos it took. Your crew's route is rebuilt from its other phones, and crew scores stay.
- **Delete Night** (the organizer) removes the whole night for everyone.
- **Delete My Account** (Account & Settings) removes your profile, friends and your data from every night.

## Troubleshooting

| Problem | Try |
|---|---|
| Pings are late or missing | On the hiders' phones: Location *While Using the App*, Precise Location on, Low Power Mode off, and don't force-quit the app. Check **Phone Status** |
| "Tracking stopped" | The app was closed or location was turned off. Open the app, and tap Resume on the banner if it shows one |
| "Your phone isn't tracking" | The round started while the app was closed or in the background since the last round. Tap the notification (it opens the night) or open the app; tracking starts on its own |
| Notifications are late | The game doesn't depend on them: the clock comes from the server. Open the app to see the current phase |
| Can't join | Ask someone in the night for the current code. **New Code** replaces the old one, and codes stop working when the night ends |
| The map looks stuck | The app re-checks with the server on its own. Bring it back to the foreground, or check your connection |

Support: the Support link in **Account & Settings**.
