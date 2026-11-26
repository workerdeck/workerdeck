// Imported first by `main.tsx`: the router reads the hash at module load, and a pairing link opened on a dashboard that
// is already signed in must neither route to `#pair=...` nor keep the key in the address bar.
if (location.hash.startsWith('#pair=')) {
  history.replaceState(null, '', location.pathname + location.search)
}
