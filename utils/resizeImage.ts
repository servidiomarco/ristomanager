// Resize an image File to a max bounding box and re-encode as JPEG data URL.
// Aspect ratio is preserved. Used for menu dish photos so users don't have to
// pre-process images before upload.
export async function resizeImageToDataUrl(
  file: File,
  maxDim = 800,
  quality = 0.8
): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Il file selezionato non è un\'immagine');
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Lettura del file fallita'));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Immagine non valida'));
    el.src = dataUrl;
  });

  const ratio = Math.min(1, maxDim / img.width, maxDim / img.height);
  const w = Math.round(img.width * ratio);
  const h = Math.round(img.height * ratio);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas non supportato');
  ctx.drawImage(img, 0, 0, w, h);

  return canvas.toDataURL('image/jpeg', quality);
}
