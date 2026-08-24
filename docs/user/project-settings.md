# Group related repositories

Some work lives in one folder containing several repositories plus shared notes, prompts, or
meeting files. Add the parent folder as a project to let T3 Code discover its direct-child Git
repositories. Choose **Add repositories under _folder_** to add the parent and each repository as
separate projects grouped under the folder's name. Choose **Add folder only** to keep one project.

To group projects later:

1. Open **Settings** and select **Projects**.
2. Select a project.
3. Enter the shared parent folder in **Context root**.

Use the reset control beside **Context root** to remove the project from the group. The context
root must contain the project's workspace folder.

Agents working in a grouped repository can read the context root, including neighboring
repositories and shared files. Their working directory, source control, diffs, and checkpoints
still belong to that repository. Changes made elsewhere under the context root are not included in
the repository's checkpoint and cannot be restored from it.

# Customize a project icon

T3 Code selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files.

To choose a different icon:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Under **Appearance**, select **Choose a project file**.
4. Search for an image file and select it.

T3 Code supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.
