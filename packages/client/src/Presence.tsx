import type { Peer } from '@canvas/shared';
import type { Identity } from './identity';

/**
 * Other people's pointers over the canvas. Positions arrive about 20 times
 * per second; a short CSS transition between them makes the movement look
 * continuous without sending more messages.
 */
export function Cursors({ peers }: { peers: Peer[] }) {
  return (
    <div className="cursors" aria-hidden="true">
      {peers.map(
        (peer) =>
          peer.cursor && (
            <div
              key={peer.id}
              className="cursor"
              style={{ transform: `translate(${peer.cursor.x}px, ${peer.cursor.y}px)` }}
            >
              <svg width="16" height="20" viewBox="0 0 16 20">
                <path
                  d="M1 1 L1 16 L5 12 L8 19 L11 18 L8 11 L14 11 Z"
                  fill={peer.color}
                  stroke="#fff"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="cursor-label" style={{ backgroundColor: peer.color }}>
                {peer.name}
              </span>
            </div>
          ),
      )}
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(' ')
    .map((word) => [...word][0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

const MAX_AVATARS = 5;

/** Who has the canvas open, you first. */
export function PeerList({ me, peers }: { me: Identity; peers: Peer[] }) {
  const people = [{ id: 'me', name: `${me.name} (tú)`, color: me.color }, ...peers];
  const shown = people.slice(0, MAX_AVATARS);
  const hidden = people.length - shown.length;
  const label = people.length === 1 ? 'Solo tú en este lienzo' : `${people.length} personas aquí`;

  return (
    <ul className="peers" aria-label={label} title={label}>
      {shown.map((person) => (
        <li
          key={person.id}
          className="avatar"
          style={{ backgroundColor: person.color }}
          title={person.name}
        >
          {initials(person.name)}
        </li>
      ))}
      {hidden > 0 && (
        <li
          className="avatar more"
          title={people
            .slice(MAX_AVATARS)
            .map((p) => p.name)
            .join(', ')}
        >
          +{hidden}
        </li>
      )}
    </ul>
  );
}
