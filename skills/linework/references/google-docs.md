# Diagrams in Google Docs

Google Docs can't hold an SVG, and it strips the metadata out of images you paste in. So a diagram in a Doc is always a picture of a file that lives somewhere else. The trick is to make that somewhere else a Google Drive file that the doc can refresh from.

draw.io's Google Docs add-on does the refreshing. It inserts a `.drawio.svg` from Drive as an image, remembers which file it came from, and updates the image when the file changes. `linework publish` puts your diagrams in Drive at a fixed path, so each new version replaces the old file instead of creating a copy.

## One-time setup

1. Install [Google Drive for desktop](https://www.google.com/drive/download/). It syncs a local folder with your Drive, so publishing is a file copy and needs no Google login in linework.
2. In a Google Doc, open Extensions > Add-ons > Get add-ons and install "draw.io for Docs" by JGraph.

The add-on renders diagrams through draw.io's export service at convert.diagrams.net. If your diagrams can't leave your machine, use the PNG route at the end of this page instead.

## Put a diagram in a doc

```bash
linework publish docs/diagrams/checkout.drawio.svg
```

This copies the file to `My Drive/linework/<project>/docs/diagrams/checkout.drawio.svg`. `<project>` is the git repository's folder name. With several Google accounts, or to use another synced folder, pass `--to <folder>`.

Then, in the doc: Extensions > draw.io > Insert diagrams, and pick the file. If the picker doesn't list it, look in its "All files" tab.

## After the diagram changes

```bash
linework build spec.yaml -o docs/diagrams/checkout.drawio.svg   # or a hand edit in draw.io
linework publish docs/diagrams/checkout.drawio.svg
```

Give Drive a few seconds to sync. Then, in the doc: Extensions > draw.io > Update diagrams. Every image whose file changed refreshes in place.

## Editing from the doc

Select the diagram and choose Extensions > draw.io > Edit selected. draw.io opens the Drive file, and saving writes it back to Drive. The repo copy is now behind. Bring the edit back with:

```bash
linework publish --pull docs/diagrams/checkout.drawio.svg
```

`publish` refuses to overwrite a Drive copy that someone edited after the last publish. It says so, and you choose `--pull` to take their version or `--force` to replace it.

## Without Drive for desktop

- Upload the `.drawio.svg` at drive.google.com and insert it with the add-on as above. To update it later, use the file's Manage versions > Upload new version in Drive. Uploading it again as a new file breaks the link to the doc.
- Or skip the add-on: `linework render docs/diagrams/checkout.drawio.svg -o checkout.png --scale 2`, insert the PNG, and put a link to the source file under it. You'll replace the image by hand when it changes.
