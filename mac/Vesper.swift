import Cocoa
import WebKit

// Vesper — a thin native shell around the local server.
// The UI lives in WKWebView; this file owns the window, the menu, and the
// lifetime of the Node process so quitting the app never leaves an orphan.

private let portsToTry = [4173, 4174, 4175, 4176, 4177]

private enum NodeFinder {
    static func find() -> String? {
        let fm = FileManager.default
        var candidates: [String] = []
        if let override = ProcessInfo.processInfo.environment["VESPER_NODE"] {
            candidates.append(override)
        }
        if let resources = Bundle.main.resourceURL {
            candidates.append(resources.appendingPathComponent("node").path)
        }
        candidates += ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        candidates += [
            NSString(string: "~/.volta/bin/node").expandingTildeInPath,
            NSString(string: "~/.asdf/shims/node").expandingTildeInPath,
            NSString(string: "~/.local/share/fnm/aliases/default/bin/node").expandingTildeInPath
        ]
        let nvmRoot = NSString(string: "~/.nvm/versions/node").expandingTildeInPath
        if let versions = try? fm.contentsOfDirectory(atPath: nvmRoot) {
            for version in versions.sorted(by: >) {
                candidates.append("\(nvmRoot)/\(version)/bin/node")
            }
        }
        for path in candidates where fm.isExecutableFile(atPath: path) {
            return path
        }
        return nil
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var server: Process?
    private var logHandle: FileHandle?
    private var port = portsToTry[0]
    private var ownsServer = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMenu()
        Task { @MainActor in
            await launch()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        stopServer()
    }

    // MARK: - Startup

    @MainActor
    private func launch() async {
        guard let projectDir = serverDirectory() else {
            fail("Vesper's application files are missing.", detail: "Reinstall Vesper from the DMG.")
            return
        }

        var picked = false
        var reused = false
        for candidate in portsToTry {
            if await isVesper(candidate) {
                port = candidate
                reused = true
                picked = true
                break
            }
            if !(await isListening(candidate)) {
                port = candidate
                picked = true
                break
            }
        }

        guard picked else {
            fail("Every local port is busy.", detail: "Close another copy of Vesper or another service on ports 4173–4177.")
            return
        }

        if !reused {
            guard let node = NodeFinder.find() else {
                fail("Node.js was not found.", detail: "Install Node 20 or newer, or set VESPER_NODE to its full path.")
                return
            }
            startServer(node: node, projectDir: projectDir)
            ownsServer = true
        }

        let ready = await waitForServer()
        guard ready else {
            fail("Vesper's local server did not start.", detail: "Reopen the app to try again.")
            return
        }

        buildWindow()
        loadInterface()
        NSApp.activate(ignoringOtherApps: true)
    }

    private func serverDirectory() -> URL? {
        let fm = FileManager.default
        var candidates: [URL] = []
        if let resources = Bundle.main.resourceURL {
            candidates.append(resources.appendingPathComponent("app"))
        }
        let bundle = Bundle.main.bundleURL
        candidates.append(bundle.deletingLastPathComponent())
        candidates.append(bundle)
        for candidate in candidates {
            if fm.fileExists(atPath: candidate.appendingPathComponent("server.mjs").path) {
                return candidate
            }
        }
        return nil
    }

    private func startServer(node: String, projectDir: URL) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [projectDir.appendingPathComponent("server.mjs").path, "--port=\(port)"]
        process.currentDirectoryURL = projectDir

        var environment = ProcessInfo.processInfo.environment
        let extra = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        environment["PATH"] = extra + ":" + (environment["PATH"] ?? "")
        environment["VESPER_APP_PATH"] = Bundle.main.bundleURL.path
        if let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String {
            environment["VESPER_VERSION"] = version
        }
        process.environment = environment

        // No log file is written. Set VESPER_LOG=/path/to/file to opt in
        // when debugging a local build.
        if let log = ProcessInfo.processInfo.environment["VESPER_LOG"], !log.isEmpty {
            FileManager.default.createFile(atPath: log, contents: nil)
            if let handle = FileHandle(forWritingAtPath: log) {
                handle.seekToEndOfFile()
                process.standardOutput = handle
                process.standardError = handle
                logHandle = handle
            }
        } else {
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
        }

        process.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, self.ownsServer, self.server === proc, proc.terminationStatus != 0 else { return }
                self.fail("Vesper's local server stopped.", detail: "Status \(proc.terminationStatus). Reopen the app to try again.")
            }
        }

        do {
            try process.run()
            server = process
        } catch {
            fail("Could not start Node.js.", detail: error.localizedDescription)
        }
    }

    private func stopServer() {
        guard ownsServer, let process = server, process.isRunning else { return }
        process.terminate()
        let deadline = Date().addingTimeInterval(2)
        while process.isRunning && Date() < deadline {
            usleep(60_000)
        }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    }

    private func isVesper(_ candidate: Int) async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(candidate)/api/health") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 0.7
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse,
              http.statusCode == 200,
              let text = String(data: data, encoding: .utf8) else { return false }
        return text.contains("Vesper")
    }

    private func isListening(_ candidate: Int) async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(candidate)/") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 0.7
        do {
            _ = try await URLSession.shared.data(for: request)
            return true
        } catch {
            return false
        }
    }

    private func waitForServer() async -> Bool {
        for _ in 0..<72 {
            if await isVesper(port) { return true }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        return false
    }

    // MARK: - Window

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 840),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Vesper"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor(calibratedRed: 0.035, green: 0.039, blue: 0.043, alpha: 1)
        window.appearance = NSAppearance(named: .darkAqua)
        window.minSize = NSSize(width: 1040, height: 680)
        window.setFrameAutosaveName("VesperMainWindow")
        window.delegate = self
        window.center()

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        if #available(macOS 12.0, *) {
            webView.underPageBackgroundColor = NSColor(calibratedRed: 0.035, green: 0.039, blue: 0.043, alpha: 1)
        }
        webView.autoresizingMask = [.width, .height]
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
    }

    private func loadInterface() {
        guard let url = URL(string: "http://127.0.0.1:\(port)") else { return }
        webView.load(URLRequest(url: url))
    }

    // MARK: - Menu

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Vesper", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Check for Updates…", action: #selector(checkForUpdates), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Vesper", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Vesper", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
        let browser = viewMenu.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "o")
        browser.keyEquivalentModifierMask = [.command, .shift]
        viewItem.submenu = viewMenu
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)

        NSApp.mainMenu = main
    }

    // MARK: - Navigation

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        let scheme = (url.scheme ?? "").lowercased()
        if scheme == "about" || scheme == "blob" || scheme == "data" {
            decisionHandler(.allow)
            return
        }
        let host = (url.host ?? "").lowercased()
        if host == "127.0.0.1" || host == "localhost" {
            decisionHandler(.allow)
            return
        }
        // Anything outside the local server belongs in the user's browser.
        if scheme == "http" || scheme == "https" {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    @objc private func reloadPage() {
        webView.reload()
    }

    @objc private func checkForUpdates() {
        webView.evaluateJavaScript("window.vesper && window.vesper.checkUpdates()", completionHandler: nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func openInBrowser() {
        NSWorkspace.shared.open(URL(string: "http://127.0.0.1:\(port)")!)
    }

    // MARK: - Failures

    private func fail(_ message: String, detail: String) {
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = detail
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Quit")
        alert.runModal()
        NSApp.terminate(nil)
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
