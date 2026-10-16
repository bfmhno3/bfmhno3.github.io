# Code in Posts

Applies to every code block under `src/content/posts/`. Biome only formats JS and TS, so these rules are enforced by hand and with the tools named per language (when available).

## General rules

- Tag each fence correctly: `c`, `cpp`, `python`, `rust`, `bash`, and `text` for program output. Never tag C++ as `c` or the reverse.
- Run the code before publishing. State the compiler or interpreter version and flags in the prose. Paste real output; never hand-write it.
- A block is a complete program or a fragment whose omissions are marked with an ellipsis comment.
- Respect the line-width limit of the language so blocks do not scroll horizontally.
- Label code that intentionally breaks a rule (`// BAD`, `// error: ...`).
- Quoted upstream code (kernel source, Kconfig, DTS, library headers) keeps its formatting and names its source.
- Identifiers are English. Comments follow the post language and the Chinese-English spacing rule.
- Other languages have no project style: follow the upstream convention or tool default. Use 2 spaces for YAML, JSON, Nix, and CMake, and tabs in Makefiles.
- When editing an old post, fix only the blocks you touch. Commit restyling separately from content changes.

## C: Linux kernel coding style

Reference: `Documentation/process/coding-style.rst`. Applies to user-space examples. Kernel-only types (`u8`, `u32`, `__user`) appear only in kernel code.

- **Indent and width**: tabs of width 8, never spaces; 80 columns. Keep literal tabs in the source and confirm once with `pnpm dev` that they render sensibly. `switch` and `case` share a column. Wrapped arguments align with the opening parenthesis.
- **Braces**: same line for `if`, `for`, `while`, `do`, `switch`, `struct`, `union`, `enum`; own line for function definitions. Closing brace alone unless followed by a continuation (`} else {`, `} while (cond);`). No braces around a single statement, unless another branch of the same `if`/`else` needs them.
- **Spaces**: one after `if`, `switch`, `case`, `for`, `do`, `while`; none after `sizeof`, `typeof`, `alignof`, `__attribute__`, or a function name; none inside parentheses. Space around binary and ternary operators; none after unary operators or around `.` and `->`. No trailing whitespace.
- **Pointers**: `*` binds to the name: `char *p`.
- **Naming**: lowercase with underscores; no CamelCase or Hungarian notation. Macros and enum constants are UPPERCASE. Short locals (`i`, `tmp`), descriptive globals. Do not `typedef` structs or pointers.
- **Functions**: short and single-purpose. `goto` label for centralized cleanup. Action functions return `0` or `-errno`; predicates return `bool`. Use `int main(void)` when there are no arguments.
- **Idioms**: `sizeof(*p)` over `sizeof(struct foo)`. Do not cast `malloc()`.
- **Comments**: `/* ... */` only. Multi-line form: `/*` alone on the first line, each line prefixed with ` * `, `*/` alone on the last. Explain why, not how.
- **Verification**: `scripts/checkpatch.pl --no-tree --file <file>` or `clang-format` with the kernel's `.clang-format`. Compile with `-Wall -Wextra`.

## C++: Google C++ Style Guide

Formatting and naming are mandatory. Language-feature restrictions (such as the exception ban) do not apply to posts whose topic is that feature, for example `cpp-exception`. State the C++ standard in the prose; default to C++20.

- **Indent and width**: 2 spaces, never tabs; 80 columns.
- **Braces**: same line, including functions and classes; `} else {`. Omit braces only for a single-line `if` with no `else`.
- **Access specifiers**: `public:`, `protected:`, `private:` indented 1 space, in that order.
- **Pointers and references**: attach to the type: `char* c`, `const std::string& s` (opposite of the C rule). One declaration per line.
- **Initializer lists** that do not fit on one line: break before the colon, indent 4, one initializer per line, aligned after the colon.
- **Naming**:

| Entity | Style | Example |
| --- | --- | --- |
| File | `snake_case`, `.cc` and `.h` | `http_client.cc` |
| Type | `PascalCase` | `UrlTable` |
| Variable, parameter | `snake_case` | `table_name` |
| Class data member | `snake_case_` | `table_name_` |
| Struct data member | `snake_case` | `name` |
| Constant, enumerator | `kPascalCase` | `kDaysInAWeek` |
| Function | `PascalCase` | `AddTableEntry()` |
| Trivial accessor, mutator | like a variable | `count()`, `set_count()` |
| Namespace | `snake_case` | `web_search` |
| Macro | `UPPER_SNAKE_CASE` with prefix | `MYPROJ_ROUND` |

- **Includes**: related header, C system, C++ standard, other libraries, project; blank line between groups, alphabetical within. Header guards `PROJECT_PATH_FILE_H_`, not `#pragma once`.
- **Idioms**: no `using namespace`; `nullptr`, `enum class`, `constexpr`, `override`, `= default`, `= delete`, `explicit` on single-argument constructors, `static_cast` over C-style casts.
- **Comments**: `//`. Doc comments sit above the declaration and describe its contract.
- **Verification**: `clang-format --style=Google`, `clang-tidy`. Compile with `-Wall -Wextra`.

## Python: PEP 8

References: PEP 8, PEP 257, PEP 484.

- **Indent and width**: 4 spaces, never tabs; 79 columns for code, 72 for comments and docstrings.
- **Naming**: `snake_case` functions, variables, modules; `CapWords` classes; `UPPER_SNAKE_CASE` constants; leading underscore for non-public names.
- **Imports**: top of file, one per line, absolute, grouped stdlib / third party / local, no `import *`.
- **Whitespace**: two blank lines around top-level definitions, one between methods. No spaces around `=` in unannotated defaults and keyword arguments (`f(a=1)`); spaces when annotated (`a: int = 1`).
- **Strings**: double quotes consistently (PEP 8 does not mandate; this repo matches Biome). Docstrings use `"""` with an imperative one-line summary ending in a period.
- **Idioms**: `is None`; no bare `except:`; `with` for resources; f-strings; `pathlib`. Scripts end with `if __name__ == "__main__": main()`.
- **Type hints**: annotate public functions. State the minimum Python version; use `list[int]` (3.9+) and `X | None` (3.10+) only when stated.
- **Verification**: `ruff format --line-length 79` and `ruff check`. Ruff defaults to 88 columns, so always pass the length.

## Rust: Rust Style Guide

References: the Rust Style Guide, RFC 430, Rust API Guidelines.

- **Formatting**: whatever `rustfmt` emits with default config (4 spaces, width 100, trailing commas in multi-line lists). Never hand-format against it.
- **Naming**: `snake_case` functions, methods, variables, modules, crates; `UpperCamelCase` types, traits, variants; `SCREAMING_SNAKE_CASE` constants and statics; short lifetimes (`'a`) unless a name clarifies. Acronyms are one word (`Uuid`). Conversions use `as_`, `to_`, `into_`; getters omit `get_`.
- **Docs**: `///` on items, `//!` on modules and crates, with `# Examples`, `# Errors`, `# Panics`, `# Safety` where they apply.
- **`unsafe`**: every block has a `// SAFETY:` comment; every `unsafe fn` documents `# Safety`.
- **Errors**: avoid `unwrap()` and `expect()` unless the post explains why the value cannot fail. In runnable examples prefer `?` with `fn main() -> Result<(), Box<dyn std::error::Error>>`.
- **Idioms**: omit `return` on the final expression; take `&str` and `&[T]` over `&String` and `&Vec<T>`; no glob imports except preludes and `use super::*` in tests.
- **Toolchain**: state the `rustc` version and edition in the prose.
- **Verification**: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`. Snippets that intentionally show an error or lint are exempt and must be labeled.
