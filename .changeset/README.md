# Changesets

This folder contains changesets - markdown files that describe the changes made in each PR.

## How to add a changeset

Run `bun changeset` to create a new changeset. This will prompt you to:
1. Select which packages have changed
2. Choose the semver bump type (major/minor/patch)
3. Write a summary of the changes

## Release process

When PRs with changesets are merged to main, a "Version Packages" PR is automatically created. Merging that PR will:
1. Update package versions
2. Update CHANGELOG.md
3. Publish to npm
