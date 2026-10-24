# RPcalls

**RPcalls** is a browser-based meeting and calling app inspired by the RPportal peer-to-peer chat/call work, with a Teams-like guest-link flow.

## First version includes

- Start a new room and copy/share a unique meeting link.
- External participants can join in a browser by entering a display name; they do not need a Remote Professionals account.
- Multi-participant audio/video calls using WebRTC mesh connections.
- Live meeting chat, participant list, mute/unmute, camera on/off, raise hand, and screen sharing.
- Responsive meeting workspace, guest join screen, and Material-inspired UI.
- Optional TURN server configuration for networks where STUN-only calls cannot connect.

## Configure local development

1. Copy the environment example file (.env.example) to .env.local.
2. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to the project's URL and publishable key.
3. Run `npm install`, then `npm run dev`.
4. For a production build, run `npm run build`.

The Vercel project rpcalls is linked to this repository and has the Supabase URL and publishable key configured as environment variables.

## Realtime behavior and important limitations

- Supabase Realtime is used for meeting presence, WebRTC signaling, and live chat messages.
- Rooms use cryptographically random IDs and are not listed on the home page.
- **The invite URL is a bearer link:** anyone who receives it can attempt to enter the room. Treat the link like meeting access and share it only with intended guests.
- This initial MVP does not store meeting chat history, contacts, recordings, or a meeting directory. Chat is available to people connected to the live room only.
- Media is sent peer-to-peer. With multiple participants, bandwidth use grows with the number of participants because each browser maintains peer connections to the others. For large calls, a hosted SFU/media service is recommended.
- Default connectivity uses public STUN servers. Some company networks, VPNs, and mobile connections require a TURN relay. Configure VITE_TURN_URLS, VITE_TURN_USERNAME, and VITE_TURN_CREDENTIAL in Vercel to enable one.
- This first version does not include server-enforced lobby/admission, organization sign-in, moderation audit logs, or recording. Those require a trusted server-side meeting/token service to enforce host and guest permissions. Do not treat client-side meeting controls as a security boundary.
- Never put a Supabase service_role or secret key in frontend code or Vercel variables prefixed with VITE_. The publishable key is intended to be public.

## Deployment

Vercel project: rpcalls  
GitHub repository: https://github.com/Zndr23668/RPcalls

Pushes to the default main branch trigger Vercel builds through the GitHub integration.
