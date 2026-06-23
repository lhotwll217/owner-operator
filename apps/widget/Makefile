# oo-widget — build/run helpers. No Xcode, no signing: SwiftPM + system frameworks only.

build: ## compile (release)
	swift build -c release

run: ## launch the menu bar widget
	swift run oo-widget

once: ## print the current rail and exit (smoke test)
	swift run oo-widget --once

install: ## install as a LaunchAgent — always there across logout/reboot
	./dev/install.sh

uninstall: ## remove the LaunchAgent and stop the widget
	./dev/uninstall.sh

.PHONY: build run once install uninstall
