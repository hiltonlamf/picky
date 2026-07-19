'use client';

export default function LogoutButton() {
  async function handleLogout() {
    await fetch('/api/admin/logout', { method: 'POST' });
    window.location.href = '/admin/login';
  }

  return (
    <button onClick={handleLogout} className="btn-ghost text-sm">
      Sign out
    </button>
  );
}
