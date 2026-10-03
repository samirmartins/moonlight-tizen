# Documentation image credits

The README library uses real screenshots of twelve open-source games in a
synthetic PC library. It does not claim that these games were tested on a TV,
and no game developer endorses this fork.

The original image files are retained without pixel changes in `open-games/`.
The application's existing `object-fit: cover` scales and crops their visible
area in `game-library.png` and `game-library-wake.png`; favorites, selection,
online Resume and offline Wake & play are demonstration states.
`settings.png` and `add-host.png` contain only this application's interface.
`moonlight-logo.png` renders the existing application logo from
`wasm/static/res/ic_moonlight_logo.svg`, without changes to its design. The
144 × 144 logo is centered in a transparent 1200 × 176 canvas to display at a
moderate size across the README width without requiring HTML alignment.
`interface.gif` combines Wake & play, settings, Resume and the initial Add Host
screen in that order, with three seconds per frame. Its source captures are retained
as lossless 2048 × 1152 PNGs; the GIF is scaled to 1920 × 1080 and uses a separate
256-color palette for each frame with dithering.

## Source images

| Local file | Game / credit | Source and license |
|---|---|---|
| `open-games/supertuxkart.jpg` | SuperTuxKart — STK dev team | [Supertuxkart-0.9-screenshot-2.jpg](https://commons.wikimedia.org/wiki/File:Supertuxkart-0.9-screenshot-2.jpg) · [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| `open-games/0ad.jpg` | 0 A.D. — Wildfire Games | [0 A.D. alpha 25 - playing as Spartans.jpg](https://commons.wikimedia.org/wiki/File:0_A.D._alpha_25_-_playing_as_Spartans.jpg) · artwork [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/); software GPL-2.0-or-later |
| `open-games/veloren.jpg` | Veloren — screenshot by Antimundo; game by the Veloren contributors | [Veloren-0.17-screenshot-horizon.jpg](https://commons.wikimedia.org/wiki/File:Veloren-0.17-screenshot-horizon.jpg) · screenshot [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `open-games/minetest.png` | Minetest Game — screenshot by Kotolegokot; game by the Minetest Game contributors | [Minetest screenshot 2.png](https://commons.wikimedia.org/wiki/File:Minetest_screenshot_2.png) · [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| `open-games/xonotic.jpg` | Xonotic — screenshot by greewrfdsfsf; game credit Justin, kuniu the frogg | [Xonotic Game Play - Silent Siege.jpg](https://commons.wikimedia.org/wiki/File:Xonotic_Game_Play_-_Silent_Siege.jpg) · [GPL-2.0-or-later](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html) |
| `open-games/supertux.png` | SuperTux — SuperTux Development Team | [SuperTux 0.5.1 screenshot (main page).png](https://commons.wikimedia.org/wiki/File:SuperTux_0.5.1_screenshot_%28main_page%29.png) · [GPL-2.0-or-later](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html) |
| `open-games/wesnoth.jpg` | The Battle for Wesnoth — Battle for Wesnoth developers | [Battle for wesnoth version 1.12.0 screenshot.jpg](https://commons.wikimedia.org/wiki/File:Battle_for_wesnoth_version_1.12.0_screenshot.jpg) · [GPL-2.0-or-later](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html) |
| `open-games/openttd.png` | OpenTTD with OpenGFX — OpenTTD and OpenGFX contributors; screenshot uploaded by Msaynevirta | [OpenTTD-1.3.3-en.png](https://commons.wikimedia.org/wiki/File:OpenTTD-1.3.3-en.png) · [GPL-2.0-or-later](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html) |
| `open-games/warzone2100.jpg` | Warzone 2100 — Pumpkin Studios, Pivotal Games, Eidos Interactive; screenshot uploaded by Bayo | [Warzone 2100 - main.jpg](https://commons.wikimedia.org/wiki/File:Warzone_2100_-_main.jpg) · [GPL-2.0-or-later](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html) |
| `open-games/freeciv.png` | Freeciv.net — screenshot by Andreas Rosdal; browser frame cropped by PaterMcFly | [Freeciv-net-screenshot-2010-02-14.png](https://commons.wikimedia.org/wiki/File:Freeciv-net-screenshot-2010-02-14.png) · [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| `open-games/freedoom.png` | Freedoom developers; screenshot uploaded by Drummyfish | [Freedoom 2018.png](https://commons.wikimedia.org/wiki/File:Freedoom_2018.png) · BSD 3-Clause; [copyright notice, terms and disclaimer](open-games/FREEDOOM-COPYING.adoc) retained from [the Freedoom project](https://github.com/freedoom/freedoom/blob/master/COPYING.adoc) |
| `open-games/neverball.jpg` | Neverball authors; screenshot uploaded by Drummyfish | [Neverball 1.6.0.jpg](https://commons.wikimedia.org/wiki/File:Neverball_1.6.0.jpg) · [GPL-2.0-or-later](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html) |

## Composite capture

`game-library.png`, `game-library-wake.png` and `interface.gif` are distributed under [GPL-3.0](../../LICENSE), matching the
application UI. The unchanged source images retain the licenses above.
For the cropped CC BY-SA 3.0 material incorporated into the composite, the
adaptation uses CC BY-SA 4.0 and its one-way GPLv3 compatibility. See
[CC BY-SA 3.0 section 4(b)](https://creativecommons.org/licenses/by-sa/3.0/legalcode.en)
and the [CC BY-SA 4.0 compatible-license list](https://creativecommons.org/compatible-licenses/).

The screenshot's editable source consists of the original images above and
the application's HTML/CSS/JavaScript in `wasm/`. Original game source projects:
[SuperTuxKart](https://github.com/supertuxkart/stk-code),
[0 A.D.](https://github.com/0ad/0ad),
[Veloren](https://gitlab.com/veloren/veloren),
[Minetest Game](https://github.com/luanti-org/minetest_game),
[Xonotic](https://gitlab.com/xonotic/xonotic),
[SuperTux](https://github.com/SuperTux/supertux),
[Wesnoth](https://github.com/wesnoth/wesnoth),
[OpenTTD](https://github.com/OpenTTD/OpenTTD),
[OpenGFX](https://github.com/OpenTTD/OpenGFX),
[Warzone 2100](https://github.com/Warzone2100/warzone2100),
[Freeciv](https://github.com/freeciv/freeciv),
[Freedoom](https://github.com/freedoom/freedoom),
[Neverball](https://github.com/Neverball/neverball).

Licensing pages checked on 2026-10-02. These are openly licensed images,
not a claim that the games or every element of their artwork are copyright-free.
