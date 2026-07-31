# Installation

Moonlight Tizen requires Tizen 5.5 or newer. The TV and the device used for installation must be on the same network.

## Apps2Samsung (recommended)

1. Download a `.wgt` from the [latest release](https://github.com/samirmartins/moonlight-tizen/releases/latest). Start with ForceGM; leave Moonlight's in-app *Game Mode* switch off.
2. On the TV, open **Apps**, enter `12345`, enable **Developer Mode**, provide the installer's IP address if requested, and restart the TV. Menu details vary by model.
3. Download [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung/releases/latest), open it, and select the TV or enter its IP address.
4. Choose **Custom WGT**, select the downloaded file, and install it. Sign in to a Samsung account if requested.

Use the normal WGT if ForceGM misbehaves on your TV.

### Updates

Normal and ForceGM builds from the same release replace each other without removing settings. If an older installation has a different author certificate, uninstall it before retrying; uninstalling removes saved settings.

## Tizen Studio (alternative)

If Apps2Samsung fails:

1. Install Tizen Studio with the **TV Extensions** and **Samsung Certificate Extension**.
2. Connect the TV in **Device Manager**, choose **Permit to install applications**, and create a Samsung certificate profile containing the TV's DUID.
3. Import the downloaded WGT through **File > Import > Tizen > Tizen Project**.
4. Build the imported project again with that certificate profile, then run it on the TV.

The downloaded WGT must be repackaged and signed for the TV; installing it unchanged may fail. See Samsung's [Tizen Studio instructions](https://developer.samsung.com/smarttv/develop/faq/tizen-studio.html).
