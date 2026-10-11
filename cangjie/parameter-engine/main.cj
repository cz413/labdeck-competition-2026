import std.console.*
import std.collection.*
import std.convert.*

// Protocol v1: maxRuns, tab-separated command tokens, then flag/value TSV rows.
// ASCII token validation keeps the JSON output and shell command unambiguous.
func safeToken(s: String): Bool {
    if (s.isEmpty() || s.size > 20000) { return false }
    for (b in s.toArray()) {
        if (!((b >= 65 && b <= 90) || (b >= 97 && b <= 122) || (b >= 48 && b <= 57) ||
            b == 95 || b == 46 || b == 44 || b == 58 || b == 47 || b == 43 || b == 45 || b == 61)) {
            return false
        }
    }
    return true
}
func joinTokens(tokens: ArrayList<String>, separator: String): String {
    var output = ""
    for (i in 0..tokens.size) {
        if (i > 0) { output += separator }
        output += tokens[i]
    }
    return output
}
main(): Int64 {
    try {
        let budget = Int64.parse(Console.stdIn.readln().getOrThrow())
        if (budget < 1 || budget > 32) { throw Exception("Run budget must be between 1 and 32") }
        let source = Console.stdIn.readln().getOrThrow().split("\t")
        if (source.size < 2 || !source[0].startsWith("python") || !source[1].endsWith(".py")) {
            throw Exception("Only a Python script command is supported")
        }
        for (token in source) { if (!safeToken(token)) { throw Exception("Unsafe source token") } }
        let axes = ArrayList<Array<String>>()
        let flags = ArrayList<String>()
        while (true) {
            let line = Console.stdIn.readln()
            if (line.isNone()) { break }
            let text = line.getOrThrow()
            if (text.isEmpty()) { continue }
            if (text.size > 1500) { throw Exception("Axis input too long") }
            let parts = text.split("\t")
            if (parts.size < 2 || parts.size > 17 || !parts[0].startsWith("--") || flags.contains(parts[0])) {
                throw Exception("Invalid or duplicate axis")
            }
            for (part in parts) { if (!safeToken(part)) { throw Exception("Unsafe axis token") } }
            flags.add(parts[0]); axes.add(parts)
            if (axes.size > 5) { throw Exception("At most five axes are allowed") }
        }
        if (axes.isEmpty()) { throw Exception("At least one axis is required") }
        var commands = ArrayList<ArrayList<String>>()
        commands.add(ArrayList<String>(source))
        for (axis in axes) {
            let flag = axis[0]
            var occurrences = 0
            for (token in source) { if (token == flag || token.startsWith(flag + "=")) { occurrences++ } }
            if (occurrences > 1) { throw Exception("Ambiguous duplicate source flag") }
            let values = ArrayList<String>()
            for (i in 1..axis.size) { if (!values.contains(axis[i])) { values.add(axis[i]) } }
            if (commands.size * values.size > budget) { throw Exception("Parameter combinations exceed run budget") }
            let expanded = ArrayList<ArrayList<String>>()
            for (command in commands) {
                for (value in values) {
                    let next = ArrayList<String>(command)
                    var found = false
                    for (i in 0..next.size) {
                        if (next[i] == flag) {
                            if (i + 1 >= next.size || next[i + 1].startsWith("--")) { throw Exception("Source flag has no value") }
                            next[i + 1] = value; found = true; break
                        }
                        if (next[i].startsWith(flag + "=")) { next[i] = flag + "=" + value; found = true; break }
                    }
                    if (!found) { next.add(flag); next.add(value) }
                    expanded.add(next)
                }
            }
            commands = expanded
        }
        var json = "{\"version\":\"1\",\"count\":" + commands.size.toString() + ",\"commands\":["
        for (i in 0..commands.size) {
            if (i > 0) { json += "," }
            json += "\"" + joinTokens(commands[i], " ") + "\""
        }
        json += "]}"
        println(json)
        return 0
    } catch (error: Exception) {
        Console.stdErr.writeln(error.message)
        Console.stdErr.flush()
        return 1
    }
}

