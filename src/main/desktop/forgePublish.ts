/** Create the private ticket store in the signed-in account before cloning its initial branch. */
export async function publishForgeRepository(name: string, token: string | null, request: (url: string, options: RequestInit) => Promise<Response>): Promise<void> {
  if (!token) throw new Error('Sign into GitHub to publish a Forge World.')
  const response = await request('https://api.github.com/user/repos', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, private: true, auto_init: true })
  })
  if (!response.ok) throw new Error('GitHub could not create this private repository (' + response.status + ').')
}
