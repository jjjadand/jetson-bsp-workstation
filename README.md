# Jetson BSP Workstation

## Overview

This repository contains a workstation project for managing Jetson BSP package uploads from NAS to OneDrive and synchronizing release links back into the Seeed wiki workspace.

The main application lives in `nas-uploader/` and provides:

- A Vue frontend for browsing NAS files, searching, filtering, selecting, uploading, and synchronizing wiki links
- An Express backend for NAS scanning, upload queue management, OneDrive link generation, and wiki document updates
- Local scripts to start the full stack and to configure NAS mounting

## Repository Layout

- `nas-uploader/client/`
  Frontend application built with Vue and Vite.
- `nas-uploader/server/`
  Backend API server, upload state persistence, and wiki update logic.
- `nas-uploader/scripts/`
  Helper scripts for mounting the NAS manually or via systemd automount.
- `start_nas_uploader.sh`
  One-command launcher for backend and frontend.
- `manual_setup.md`
  Manual OneDrive/rclone configuration notes.

## Core Features

- Scan the NAS mount and show recent or all BSP files
- Persist upload state and wiki sync state across restarts
- Upload selected files to OneDrive
- Generate OneDrive share links for newly uploaded or legacy uploaded files
- Sync BSP links into local wiki sources and push changes to the configured Git remote
- Support single-file and batch wiki synchronization
- Support repeat wiki synchronization for already-synced BSP files

## Wiki Sync Behavior

Wiki synchronization currently updates two categories of sources:

1. `src/data/jetson/L4TData.json`
2. Structured documentation pages that contain BSP download tables

The updater first tries link-based replacement. If that does not find a target page, it falls back to scanning structured docs such as:

- `*Getting_Started*.md`
- `*Getting_Started*.mdx`
- `*Hardware_Interfaces*.md`
- `*Hardware_Interfaces*.mdx`
- `*Hardware_Interface*.md`
- `*Hardware_Interface*.mdx`

For those pages, it attempts to match by:

- product-derived device label, such as `reComputer Industrial J4012`
- module label, such as `Orin NX 16GB`
- JetPack tab/section label
- download-table row structure

This makes the project more robust for reComputer and part of the reServer wiki pages, but it is still rule-based rather than a full explicit page mapping system.

## Runtime Configuration

The backend reads runtime configuration from:

- `nas-uploader/server/config.json`

Current configuration supports:

- NAS mount source/target/options
- OneDrive remote and destination directory
- Local wiki repository path
- Wiki git remote and branch used for push

## Startup

Install dependencies automatically and start both services:

```bash
./start_nas_uploader.sh
```

Default ports:

- Frontend: `5173`
- Backend: `3002`

## Notes

- `nas-uploader/server/db.json` is intentionally excluded from git because it stores local persistent upload state.
- `nas-uploader/server/queue.json` is also ignored because it is runtime queue state.
- The backend dev script now uses `node --watch index.js`, so server changes reload through the main entrypoint.
- The local wiki repo may still contain unrelated untracked files such as `sites/en/src/data/jetson/update-BSP.json`; those are outside the uploader's intended commit set.

## Current Project Scope

This repository now reflects the latest integrated version of the NAS uploader workflow, including:

- persisted upload/wiki status
- legacy OneDrive link recovery
- batch wiki sync
- repeat wiki sync
- git push with remote-branch alignment
- fallback updates for structured wiki documentation pages
