TaskDesk desktop app updates
============================
This folder is served publicly (no sign-in) at http://<server>:3000/updates/
The TaskDesk desktop app on employee laptops checks it for new versions.

What goes here (put them directly in this folder, no sub-folders):
  latest.yml                      Windows update info
  TaskDesk Setup <version>.exe    Windows installer
  TaskDesk Setup <version>.exe.blockmap
  latest-linux.yml                Ubuntu update info
  TaskDesk-<version>.AppImage     Ubuntu app

Do not edit the .yml files by hand.
Normally you do not copy anything yourself: run "npm run release" inside the
desktop/ folder after bumping the version in desktop/package.json. It builds
both versions and copies the files here. Laptops update within 4 hours.
