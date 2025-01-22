[![CodeQL Advanced](https://github.com/NDDonman/revisions/actions/workflows/codeql.yml/badge.svg)](https://github.com/NDDonman/revisions/actions/workflows/codeql.yml)
[![Dependabot Updates](https://github.com/NDDonman/revisions/actions/workflows/dependabot/dependabot-updates/badge.svg)](https://github.com/NDDonman/revisions/actions/workflows/dependabot/dependabot-updates)
# Revisions - VS Code Extension

Revisions is a powerful VS Code extension that helps you maintain a history of your code changes, allowing you to create, view, compare, and restore previous versions of your files.

## Features

- **Automatic Snapshots**: Automatically creates a snapshot of your file every time you save.
- **Manual Snapshots**: Ability to manually create a snapshot at any time.
- **View History**: See a list of all revisions for a file.
- **Compare Revisions**: Compare any revision with the current file state.
- **Restore Revisions**: Easily restore your file to any previous revision.
- **Cleanup Old Revisions**: Remove old revisions to manage storage.

## Installation

1. Open VS Code
2. Go to the Extensions view (Ctrl+Shift+X or Cmd+Shift+X on macOS)
3. Search for "Revisions"
4. Click Install

Alternatively, you can download the .vsix file and install it manually:

1. Download the .vsix file
2. In VS Code, go to the Extensions view
3. Click on the "..." at the top of the Extensions view and select "Install from VSIX..."
4. Select the downloaded .vsix file

## Usage

### Creating a Snapshot

- Snapshots are automatically created when you save a file.
- To manually create a snapshot, use the command palette (Ctrl+Shift+P or Cmd+Shift+P on macOS) and search for "Revisions: Create Snapshot".

### Viewing Revision History

1. Open the file you want to view the history for.
2. Open the command palette and search for "Revisions: View History".
3. A new panel will open showing all revisions for the file.

### Comparing Revisions

In the revision history view, click the "Compare" button next to any revision to compare it with the current file state.

### Restoring a Revision

In the revision history view, click the "Restore" button next to the revision you want to restore.

### Cleaning Up Old Revisions

1. Open the command palette and search for "Revisions: Clean Up Old Revisions".
2. Enter the number of days. Revisions older than this will be removed.

## Configuration

You can configure the maximum number of revisions to keep per file:

1. Go to File > Preferences > Settings (Code > Preferences > Settings on macOS)
2. Search for "Revisions"
3. Adjust the "Max Revisions Per File" setting

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License.

## Support

If you encounter any problems or have any suggestions, please open an issue on the GitHub repository.

Enjoy using Revisions!
