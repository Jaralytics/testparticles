# testparticles

Página de login de prueba con texto hecho de partículas WebGL. Decenas de miles de partículas flotan como polvo y forman las palabras "Angel", "Daniel", "Es" y "Feo". Cada palabra se desvanece en una nube y esa misma nube se reorganiza en la siguiente. Al enfocar el campo de contraseña, un enjambre de partículas vuela hasta él y lo tapa.

**Demo:** https://jaralytics.github.io/testparticles/

## Archivos

| Archivo | Contenido |
|---|---|
| `index.html` | La página de login: layout, estilos, tema claro/oscuro, botón de pausa y conexión del campo de contraseña con el enjambre. |
| `particle-text.js` | Motor de partículas (módulo ES, WebGL1, sin dependencias). |

## Ejecutar en local

El motor es un módulo ES, así que hay que servir la carpeta por HTTP (abrir `index.html` con doble clic no funciona):

```sh
python -m http.server 5173
```

Luego abre http://localhost:5173/.

## Uso del motor

```js
import { createParticleText } from './particle-text.js';

const fx = await createParticleText(document.getElementById('hero'), {
  words: ['Angel', 'Daniel', 'Es', 'Feo'],
  fontFamily: '"Inter", system-ui, sans-serif',
  textBox: document.getElementById('slot'),
  accentIndex: 3, // "Feo" en color acento
});

passwordInput.addEventListener('focus', () => fx.shield(passwordInput));
passwordInput.addEventListener('blur', () => fx.release());
```

| Método | Qué hace |
|---|---|
| `play()` / `pause()` | Reanuda o pausa la animación. |
| `setTheme('light' \| 'dark')` | Cambia la paleta y reinicia el ciclo. |
| `setWords([...])` | Cambia las palabras y reinicia el ciclo. |
| `ripple(x, y)` | Lanza una onda desde ese punto (relativo al contenedor). Se dispara sola al hacer clic. |
| `shield(elemento)` | Manda un enjambre de partículas a cubrir el elemento. |
| `release()` | Devuelve el enjambre al polvo del fondo. |
| `destroy()` | Libera la GPU, los observers y los listeners. |

`createParticleText` devuelve `null` si el navegador no tiene WebGL; en ese caso llama a `onFallback` y la página muestra el texto estático.

### Ajustes útiles

- **Duración de la transición entre palabras:** opción `timing` (`hold`, `morph`, `spread`, en segundos) y la constante `MORPH_K` en `particle-text.js`.
- **Qué tanto se dispersa la nube entre palabras:** el multiplicador `vec3(240.0, 150.0, 700.0)` del vertex shader.
- **Qué tan difusas se ven las letras:** opción `fuzz` (`radius`, `depth`, `wobble`, como fracción del tamaño de la fuente). `{ radius: 0, depth: 0, wobble: 0 }` deja las letras nítidas.
- **Onda al hacer clic:** opción `ripple` (`speed` en px/s, `width` y `strength` en px, `life` en segundos). `strength: 0` la desactiva.
- **Densidad del enjambre:** opción `shield` (`pad`, `density`, `size`, `share`).

## Notas

- El bloqueo es solo visual: se puede seguir escribiendo en el campo, pero no se ve lo que se escribe.
- El formulario no envía nada; es una página de prueba.
- La animación se pausa sola cuando la pestaña está oculta o la página sale de la vista. Con `prefers-reduced-motion` se muestra un solo cuadro fijo.
