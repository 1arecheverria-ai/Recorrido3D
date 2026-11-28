# Huella 3D

Página web que convierte el GPX de una caminata en un video MP4 con el recorrido animado sobre un mapa 3D (imagen satelital + relieve), distancia, altura y perfil de altura.

- Todo se procesa en el navegador de quien la usa: el GPX y el video no se suben a ningún servidor.
- Funciona en Chrome o Edge actualizados (PC recomendada). Safari 17+ también.
- Mapas: imágenes © Esri (World Imagery) y relieve de AWS Terrain Tiles (Mapzen). Sin clave ni costo; la atribución va dentro del video.

## Uso

1. Abrir la página y elegir el archivo `.gpx` (Wikiloc, Strava, Garmin, etc.).
2. Escribir título y subtítulo.
3. Opcional: elegir el logo del grupo (queda guardado en ese navegador), agregar fotos y música de fondo.
4. Elegir duración, calidad, exageración del relieve y color.
5. **Vista previa** para ver la animación; **Generar video** para descargar el MP4.

La generación se hace cuadro por cuadro y espera a que cargue cada parte del mapa, así que tarda más que la duración del video (en una PC común, unos 3 a 10 minutos para 45 s en 720p).

## Fotos

- Se ubican en el recorrido por el GPS de la foto (hasta 300 m de la traza) o, si no tiene GPS, por la hora de toma cruzada con las horas del GPX.
- Las fotos sin GPS ni hora (por ejemplo, reenviadas por WhatsApp) se descartan.
- En cada foto la cámara se detiene unos 4 s; el video se alarga si hace falta. Máximo 20 fotos.
- Formato JPG. Las fotos HEIC del iPhone solo se abren en Safari; en Chrome conviene configurar el iPhone en *Ajustes → Cámara → Formatos → Más compatible*.

## Música

- Se sube un MP3 o M4A; se ajusta a la duración del video (se repite si es corta) con fundido al inicio y al final.
- Se puede elegir desde qué segundo empieza la canción.
- El audio sale en AAC con Chrome o Edge en Windows/Mac. Si el navegador no tiene AAC usa Opus, que algunos celulares no reproducen.

## Publicar en GitHub Pages

1. Subir estos archivos a un repositorio público.
2. En GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, rama `main`, carpeta `/ (root)` → **Save**.
3. Al minuto queda en `https://<usuario>.github.io/<repositorio>/`.

## Archivos

- `index.html`, `styles.css`, `app.js`: la aplicación.
- `vendor/`: MapLibre GL JS 4.7.1 (BSD-3) y mp4-muxer 5.1.3 (MIT), con sus licencias.
