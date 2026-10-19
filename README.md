# VacacionesLand3

Launcher de Minecraft para los modpacks Principal y Optimizado de VacacionesLand3.

- Minecraft Java 1.21.1 y NeoForge 21.1.256.
- Selector entre Principal y Optimizado, con instancias y sincronizaciones separadas.
- Botón **Jugar**: abre la instancia local sin conectarse al PC administrador. Descarga Java 21 automáticamente si hace falta. Si la instancia no tiene mods, explica que hay que hacer la primera actualización.
- Inicio de sesión con Microsoft o perfil offline con nombre local.
- El cubito de cuenta abre el selector de cuenta y muestra la cabeza de la skin de Microsoft cuando hay una configurada.
- Sincronización SHA-256 de mods, configuración (`config` y `defaultconfigs`) y paquetes de recursos (`resourcepacks`) desde el PC administrador mientras está encendido y VacacionesLand3 está abierto.
- Los controles iniciales se copian desde `options.txt` del administrador una sola vez; luego cada jugador conserva sus propias teclas.

## Crear el instalador de Windows

Instala Node.js 20 o posterior. Desde esta carpeta ejecuta:

```powershell
npm install
npm run dist:win
```

El instalador se genera en `release/`.

## Cuentas y seguridad

Microsoft requiere una cuenta que tenga Minecraft Java. La sesión se guarda cifrada mediante el almacenamiento seguro de Windows. Los perfiles offline no verifican propiedad del nombre.

El servidor VacacionesLand3 usa `online-mode=false`, así que tampoco comprueba las identidades Microsoft al entrar: cualquiera podría entrar usando el nombre de otro jugador. Configura autenticación y permisos en el servidor, limita quién puede conectarse y no concedas OP basándote solo en el nombre.

## Compartir las actualizaciones de mods

1. En el PC administrador, elige la carpeta de instancia del Principal y pulsa su botón **Publicar**. Repite con la carpeta del Optimizado. Cada carpeta debe contener `mods`, `config`, `resourcepacks` y `options.txt` (si quieres compartir controles iniciales). También puedes elegir directamente `mods` si las demás carpetas están junto a ella.
2. Comparte la dirección que aparece. Para amigos fuera de casa, usa una VPN privada como Tailscale o configura la red para permitir el puerto TCP 8765.
3. En el PC de cada amigo, introduce esa dirección en **Conectarse al modpack** y pulsa **Conectar**. Selecciona Principal u Optimizado en la pantalla de inicio; pulsa **Actualizar mods** para actualizar ese pack.
4. Cada perfil usa su propia instancia local. **Jugar** abre el perfil seleccionado sin conectarse; pulsa **Actualizar mods** cuando el administrador anuncie cambios.

El PC administrador debe permanecer encendido y VacacionesLand3 abierto mientras tus amigos sincronizan. Se publican archivos de esas carpetas; en `mods` solo se comparten `.jar`. La sincronización agrega y reemplaza archivos del pack, y retira archivos del pack que el administrador haya quitado. El servidor de sincronización actual usa HTTP sin inicio de sesión; compártelo solo en una red privada o VPN de confianza.
