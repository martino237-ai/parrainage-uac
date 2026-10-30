export const API = import.meta.env.VITE_API_URL || '';
export const tok = () => sessionStorage.getItem('tok');
export const photo = (id, admin) => `${API}/api/photo/${id}${admin ? `?t=${tok()}` : ''}`;

export async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  const t = tok();
  if (t) headers.Authorization = 'Bearer ' + t;
  let payload;
  if (form) payload = form;
  else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(API + path, { method, headers, body: payload });
  const isJson = (r.headers.get('content-type') || '').includes('json');
  const data = isJson ? await r.json() : await r.blob();
  if (!r.ok) {
    if (r.status === 401 && t) { sessionStorage.removeItem('tok'); location.href = '/admin'; }
    throw new Error((isJson && data.error) || 'Erreur réseau');
  }
  return data;
}
