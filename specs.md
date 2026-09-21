# AI Podcast API
This is the rest API for the AI Podcast app, which utilizes LLMs and LLM-based TTS services to generate realistic podcasts from sources provided by the user.

## Basic Product Specifications
### Podcasts and Episodes
Users will be able to create Podcast shows and episodes for those shows. A Podcast will have a Theme, A Structure and one or more fixed hosts. An Episode will have one or more topics and can receive guests. Hosts will remember previous episodes.

### Podcast Structure
Each created podcast will have a unique structure decided by the user that will make sense with the theme and premise of the show. That structure can be anything that defines how the episodes will be built, from specific blocks all episodes will have to wether episodes will have guests and what are the hosts and guests role in each episode.

### Pre Production Material
Users will be able to upload sources to be used as pre-production material for each episode. Hosts and guests will all be provided with these sources before the show starts.

### Realistic talk
Episodes will aim for realistic talk by making each speaker an independent individual, only having the knowledge of the pre-production material in common with the others

### Hosts and Guests
All hosts and guests of these podcasts will be fictional but should have life-like personas that make them relevant for the topics the podcasts and episodes will touch upon.

## Podcast Creation Experience
Users will be able to create podcasts, and then episodes, by following a wizard-like step-by-step flow

### Creating Podcasts

1. User inputs an initial prompt for what they want the podcast to be like and, optionally, sample source material they would like to use
2. The app suggests 3 options for the podcast. Each option will have a name, a short descritpion, a structure and the hosts' details. Each option will be accompained by 3 predicted changes the user might want to make to them.
    2.a. The User might choose to modify one of the sugested options, either by choosing one of the predicted changes or by inputing a new one themselves. In this case, the app will re-generate that option based on the response.
    
    2.b. The user might choose to revise all options by inputing their revision instead of choosing one of them. In this case, the app will re-generate all options based on the response
3. Users will be able to change all aspects of the podcast by editing the name, the description, the structure and each of the hosts names and voices
4. When the user makes the final confirmation on an option, that will be committed to the Database as the podcast

### Editing Podcasts
After the podcast is created, users will still bew able to modify it the same way they could on step 3 of the creation process. Changes to the podcast will only take effect on future episodes.

### Episode Creation
1. User picks a target episode length (short/medium/long — see Episode duration below), uploads the material the episode should focus on, and optionally adds a prompt on how the material should be aproached. Users can also select from previously uploaded material in the same podcast.
2. The app suggests the initial episode title, topics, and prodiction notes, based on the user's material, prompt, and chosen length, along with any guests the episode might have. The app will also provide 3 predicted changes the user might want to make to the episode.
    2.a. If the user decides to make any changes, either by selecting one of the predicted ones or inputing their own, the app will re-generate the episode based on the response.
    2.b. If the chosen length is too short to do the material justice, the app will also suggest splitting it into two episodes ("Part 1"/"Part 2"), each individually fitting the chosen length — the user sees both the single-episode suggestion and the split side by side and picks which to go with.
3. Users will be able to edit the episode information before it's created by editing the title, topics, produiction notes and each of the guests.
4. When the user makes the final confirmation, they confirm the whole chosen suggestion at once — a single episode, or both parts of a split together. The app begins generation for all of them right away (See Episode generation on the technical specifications), but generates a split's parts one after the other behind the scenes, so the second part can build on the first part's continuity — this sequencing is invisible to the user, who just sees both episodes progress in turn.

## Technical Specifications

### Authentication
The app authenticates users via Firebase Auth. Clients sign in directly with the Firebase Auth SDK (email/password, anonymous, or any other provider enabled on the project) and send the resulting ID token with every API request. This API never handles credentials itself, only verifies the token.

Every endpoint operating on a podcast (and anything nested under it — sources, episodes, audio) requires a valid ID token. Each podcast is owned by the user who created it (see the `owner_id` field below), and a podcast belonging to another user is indistinguishable from one that doesn't exist at all — the same as attempting to access someone else's data returns a not-found response, never a distinct "forbidden" response, so existence isn't leaked. Reference/health endpoints that aren't user-scoped data do not require authentication.

Because a standard web `<audio>` element cannot attach custom headers to the request it issues, the audio streaming endpoint additionally accepts the ID token as a query parameter, so it can be used directly as that element's `src`.

### Database
The app will use Firebase Firestore as its database with the following structure:

- Podcasts
    - id
    - Title
    - **owner_id** - The id of the user who created this podcast, from Firebase Auth. Only this user may access the podcast or anything nested under it.
    - **description** - A brief description of the podcast, to be used as context for episode generation and for displaying on clients
    - **structure** - A textual description (in markdown format) of how each episode of this podcast is structured
    - hosts (nested array):
        - name
        - **voice** - Voice ID from the TTS service
        - **persona** - A description of the character created for this host
    - episodes (nested array):
        - id
        - Title
        - **topics** - A textual description of the topics of this show.
        - **Length** - The expected lenght range of the episode, an enum of short, medium and long
        - **sources** - (nested array of the source_ids used in this episode)
        - **Guests**  (Nested Array, same structure as hosts)
        - **Production Notes** - Directional information for the hosts on how this episode should be driven
        - **TTS Prompt** - The base prompt that will be sent to the TTS services to generate audio.
        - **Transcript** - A Transcript of the episode, which will be used by the TTS services to generate the audio.
    - sources (nested array)
        - id
        - title
        - contents

### Episode Generation
This app generates an episode's transcript with a single LLM call that writes both speakers' lines itself, given the podcast and episode information as context, including the source material selected. Hosts are also given condensed past episodes' transcripts for continuity. Due to TTS limitations, each episode can only have 2 voices, being either 2 hosts or 1 host and one guest.
* **Hosts and Guests:** The two speakers are written as independent individuals as far as the generated dialogue goes — each only reacts to their own persona, their own background material, and whatever the other has actually said aloud — even though a single model is authoring both sides. This is a prompting goal, not a structural guarantee the way giving each speaker its own separately-scoped generation call would be.
* **Realistic Conversation:** 
    * **Kickoff**: The Episode's host (or one of them, decided randomly, if the podcast has more than one), opens the episode following the podcast's structure and the production notes.
    * **Conversation Rounds:** The other host, or the guest, responds to what the previous speaker said, and may or may not prompt a follow-up. Turns aren't required to strictly alternate or be evenly sized — a natural conversation has short reactions, interjections, and unevenly-sized turns rather than balanced back-and-forth statements.
* **Episode duration:** Episodes will aim for a range of spoken words that will losely correspond to a target time, based on their expected lenghts, chosen up front before drafting (see Episode Creation above). This is a target for the generation to aim for, not a hard guarantee — see Known limitations in README.md.
    * short: 3500 to 5000 words, approximately 20 to 35 minutes.
    * medium: 6500 to 8000 words, approximately 40 to 50 minutes
    * long: 9000 words max, approximately a little over one hour.
* **Transcript production:** The Episode's transcript is the single script-writing LLM call's own output, parsed into per-speaker turns, following the prompting-guide.md on how to format audio tags.
* **Prompt Generation** The producer (another independent LLM) generates a base TTS prompt from the podcast/episode/persona metadata — not the transcript — based on the documentation on the prompting-guide, so it can run before (and in parallel with) the transcript being written. The app then breaks the transcript down into chunks that can be sent to the TTS service based on its defined token limit per submission. The combination of the base prompt plus the transcript chunk must be under the limit.

### Audio Delivery
* **Generation:** Audio will be generated by sending one prompt for each transcript chunk plus the base prompt to the TTS service. Audio generation will happen on-demand, as the user listens to the episode, using the TTS service's stream capabilities and be streamed back.
* **Delivery:** Audio will be available to consumers of the API through a `/stream` enpoint that should be compatible with standard client web and mobile audio players
* **Playback:** The players should be able to pause and resume the audio while streaming, but not scrubble through it before the generation of all chunks has completed. Once all audio for all chunks have been generated, playback should behave like a normal audio file.

### Technical Stack
The app will use the latest Gemini (`'@google/genai'`) models for all its LLM needs:
* Text Generation: gemini-3.8-flash
* TTS: gemini-3.1-flash-tts-preview

