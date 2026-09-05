const AVATAR_COLORS = ['#FF5733', '#33A1FF', '#33FF57', '#F39C12', '#9B59B6', '#1ABC9C'];

function colorForClientId(clientId) {
  return AVATAR_COLORS[clientId % AVATAR_COLORS.length];
}

function initials(name) {
  if (!name) return '?';
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

// Renders the "who's here" avatar strip in the living-room bar and keeps it
// in sync with the Yjs Awareness protocol exposed by the FirebaseProvider.
export class PresenceBar {
  constructor(containerEl, awareness, currentUser) {
    this.container = containerEl;
    this.awareness = awareness;

    this.awareness.setLocalStateField('user', {
      name: currentUser.displayName || currentUser.email || 'Anonymous',
      color: colorForClientId(awareness.clientID)
    });

    this._onChange = this._render.bind(this);
    this.awareness.on('change', this._onChange);
    this._render();
  }

  _render() {
    const states = Array.from(this.awareness.getStates().entries());
    this.container.innerHTML = '';

    for (const [clientId, state] of states) {
      if (!state.user) continue;

      const avatar = document.createElement('div');
      avatar.className = 'presence-avatar';
      avatar.style.background = state.user.color || colorForClientId(clientId);
      avatar.title = state.user.name;
      avatar.textContent = initials(state.user.name);
      this.container.appendChild(avatar);
    }
  }

  destroy() {
    this.awareness.off('change', this._onChange);
  }
}
