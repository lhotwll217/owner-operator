---
name: get-sidebar-threads
description: >-
  Read the current Owner Operator sidebar snapshot. Use when the user asks what is in
  the sidebar, asks about visible sidebar rows, or wants current sidebar context without
  marking anything done.
allowed-tools: get_sidebar_threads
---

# get-sidebar-threads

Use this only to read the current sidebar snapshot.

Call `get_sidebar_threads` and summarize the returned rows concisely. Do not mark
anything done or call mutation tools from this skill.
