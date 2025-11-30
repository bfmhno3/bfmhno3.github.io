---
title: "Notes of Effective CMake"
date: 2025-08-08 23:17:00 +08:00
excerpt: >-
  Notes on modern CMake best practices based on "Effective CMake". Covers the philosophy of CMake as code, the importance of targets and properties, generator expressions, dependency management, testing, and static analysis integration.
categories:
  - Note
tags:
  - CMake
---

## 1. The Philosophy of Modern CMake

### Why "Effective CMake"?

Just like with C++, the way you write CMake code significantly impacts your project's maintainability, ease of use for others, and scalability. Adopting modern practices is key.

### CMake is Code

Treat your `CMakeLists.txt` files with the same care as your source code. Apply principles like Don't Repeat Yourself (DRY), keep it clean, and write comments where necessary.

## 2. The CMake Language: A Quick Tour

### Organization

CMake code can be organized in three ways:

- **Directories (`CMakeLists.txt`)**: The entry point for a project or sub-project. `add_subdirectory()` adds another directory (which must contain a `CMakeLists.txt`) to the build.
- **Scripts (`<name>.cmake`)**: Executed with `cmake -P <script>.cmake`. They are useful for automation but cannot define build targets like executables or libraries. In other words, *not all commands are supported*.
- **Modules (`<name>.cmake`)**: Reusable code included in your projects via `include()`. They are located in the `CMAKE_MODULE_PATH`.

### Commands

CMake commands are **case-insensitive**, but their arguments (including variable names) are **case-sensitive**.

```cmake
# command_name(ARGUMENT1 ARGUMENT2 ...)
project(MyProject VERSION 1.0)
```

**Command invovations are not expressions**, so you cannnot put a command invocation directly as an argument of another command or inside an if condition. They are not possible.
{: .notice--danger}

### Variables

```cmake
# Set a variable
set(MY_VARIABLE "Hello")

# Reference a variable (dereference)
message(STATUS "My variable is: ${MY_VARIABLE}")

# Unset a variable
unset(MY_VARIABLE)
```

> :exclamation: **IMPORTANT**
>
> - In CMake, everything is a string. Lists are just strings separated by semicolons `;` (e.g., `"item1;item2;item3"`).
> - **An unset or undefined variable expands to an empty string**. This can be a common source of bugs! Use `if(DEFINED VAR_NAME)` to check if a variable is set.
> - CMake variables are not environment variables (unlink `Makefile`).
{: .notice--danger}

> :warning: **WARNING**
>
> Avoid custom variables in the arguments of project commands.
> 
> In modern CMake, what we need is targets and properties. See them later.
{: .notice--warning}

### Comments

```cmake
# This is a single-line comment.

#[=[
This is a multi-line comment.
It can contain other symbols and even # characters.
#]=]
```

### Generator Expressions: The `$<...>` Syntax

Generator expressions, often called "genex," are a powerful CMake feature that uses the `$<...>` syntax. They are **not** evaluated when CMake first reads your `CMakeLists.txt`. Instead, they are written into the native build files (like Makefiles or Visual Studio projects) and are evaluated **during the build process**.

This delayed evaluation is crucial because it allows you to create build configurations that are aware of things that are only known at build time, such as the specific build type (`Debug`, `Release`), the compiler being used, or the language of a source file.

> :exclamation: **IMPORTANT**
>
> Think of generator expressions as placeholders that the final build tool (like Make, Ninja, or MSBuild) will fill in with the correct value at the right time. This is much more flexible than using `if()` statements in CMake, which are only evaluated once when you run `cmake`.
{: .notice--danger}

#### Common Use Cases and Examples

1. **Conditional Compilation Definitions (`$<CONFIG:...>`)**

This is the most common use case. You want to define a preprocessor macro differently for `Debug` and `Release` builds.

```cmake
# In Debug mode, VERBOSITY will be 2. In all other modes (e.g., Release), it will be 0.
target_compile_definitions(my_app PRIVATE
    "VERBOSITY=$<IF:$<CONFIG:Debug>,2,0>"
)
```

The `$<IF:condition,true_value,false_value>` expression is evaluated at build time. If the configuration is `Debug`, it resolves to `VERBOSITY=2`; otherwise, it becomes `VERBOSITY=0`.

2. **Conditional Include Directories (`$<BUILD_INTERFACE:...>` and `$<INSTALL_INTERFACE:...>`)**

A library often has different include paths when being built inside a project versus when it's installed on a system.

```cmake
target_include_directories(my_lib PUBLIC
    # When my_lib is built as part of this project, use the source directory.
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>

    # When an external project uses an installed version of my_lib, the path is just 'include'.
    $<INSTALL_INTERFACE:include>
)
```

This ensures your library is usable both during development and after deployment without any changes.

3. **Compiler-Specific Flags (`$<CXX_COMPILER_ID:...>`)**

You can pass specific flags depending on the compiler being used (e.g., GCC, Clang, MSVC).

```cmake
# Enable strong warnings, but use the correct flag for each compiler.
set(GCC_CLANG_WARNINGS "-Wall -Wextra -Wpedantic")
set(MSVC_WARNINGS "/W4")

target_compile_options(my_app PRIVATE
    "$<IF:$<CXX_COMPILER_ID:MSVC>,${MSVC_WARNINGS},${GCC_CLANG_WARNINGS}>"
)
```

4. **Language-Specific Standards (`$<COMPILE_LANGUAGE:...>`)**

If your target mixes C and C++ code, you can set standards for each language.

```cmake
target_compile_features(my_app PRIVATE
    # Set C++ standard to 17 for all C++ files.
    $<COMPILE_LANGUAGE:CXX>:cxx_std_17

    # Set C standard to 11 for all C files.
    $<COMPILE_LANGUAGE:C>:c_std_11
)
```

Generator expressions are a cornerstone of modern, robust, and portable CMake scripts. Mastering them allows you to write cleaner and more powerful `CMakeLists.txt` files.

### Custom Commands: `function()` vs. `macro()`

You can create your own commands to reduce code duplication.

- **`function()`**: Creates a new variable scope. To pass results back to the caller, you must use `set(... PARENT_SCOPE)`.
- **`macro()`**: Does not create a new scope. It performs simple text replacement, much like a C preprocessor macro.

> :bulb: **TIP**
>
> **Rule of Thumb:**
>
> - Use `function()` by default to avoid polluting the caller's scope with side effects.
> - Use `macro()` only when you need to wrap a command that has an output parameter or when you explicitly want side effects in the caller's scope.
{: .notice--success}

## 3. The Core of Modern CMake: Targets and Properties

Modern CMake revolves around **targets** and their **properties**. A target can be an executable, a library, or a custom target.

> :warning: **WARNING**
>
> Avoid directory-level commands like `include_directories()`, `link_libraries()`, and `add_compile_options()`. They use global state and make dependencies hard to reason about. Always prefer the `target_*` equivalents.
{: .notice--warning}

> :warning: **WARNING**
>
> Don't use `file(GLOB)` in your `CMakeLists.txt` anymore.
{: .notice--warning}

### Thinking in Targets

Imagine targets as objects in an OOP language.

- **Constructor**: `add_executable()`, `add_library()`
- **Member Functions**: `target_sources()`, `target_include_directories()`, `target_link_libraries()`, etc.
- **Member Variables**: Properties like `VERSION`, `SOURCES`, `INTERFACE_INCLUDE_DIRECTORIES`.

```cmake
# Create a library target
add_library(my_lib STATIC my_lib.cpp my_lib.h)

# Add properties to the target
target_include_directories(my_lib PUBLIC include)
target_compile_features(my_lib PUBLIC cxx_std_17)
```

### Build Specifications vs. Usage Requirements

- `Non-INTERFACE_` properties define the build specification of a terget
- `INTERFACE_` properties define the usage requirements of a target.

This is the most critical concept in modern CMake. When you link a library, the consumer needs to know its include directories, compile definitions, etc.

- **`PRIVATE`**: The property is only for building this target. It is not passed on to consumers (`Non-INTERFACE_`).
- **`INTERFACE`**: The property is *only* for consumers of this target. The target itself doesn't use it for its own build. This is perfect for header-only libraries (`INTERFACE_`).
- **`PUBLIC`**: The property is for both the target's build (`PRIVATE`) and for its consumers (`INTERFACE`).

#### Example

```cmake
# A logging library that uses spdlog internally
add_library(my_logger my_logger.cpp)

# my_logger needs the spdlog headers to compile.
# Anyone who uses my_logger does NOT need spdlog headers directly.
target_include_directories(my_logger
    PRIVATE
        ${spdlog_SOURCE_DIR}/include
)

# Anyone who uses my_logger needs my_logger's own headers.
target_include_directories(my_logger
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include> # Different path after installation
)
```

### Header-Only Libraries

For libraries that are headers-only, create an `INTERFACE` library. It has no sources and only defines usage requirements.

```cmake
add_library(my_header_lib INTERFACE)

target_include_directories(my_header_lib INTERFACE
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:include>
)
```

> :warning: **WARNING**
>
> The library interface may change during installation. Use the `BUILD_INTERFACE` and `INSTALL_INTERFACE` generator expressions as filters
{: .notice--warning}

## 4. Working with Dependencies

### Finding Packages with `find_package()`

This is the standard way to find and use external libraries that have been installed on the system or are part of the project.

```cmake
# Find the Boost library, version 1.71 or newer.
# It is REQUIRED; CMake will fail if it's not found.
find_package(Boost 1.71 REQUIRED COMPONENTS system thread)

# If found, use the imported target provided by Boost
if(Boost_FOUND)
    target_link_libraries(my_app PRIVATE Boost::system Boost::thread)
endif()
```

> :memo: **Note**
>
> Regardless of the mode/package used, a `<PackageName>_FOUND` variable will be set to indicate whether the package was found.
{: .notice--info}

> :exclamation: **IMPORTANT**
>
> Always use the official, namespaced, imported targets (e.g., `Boost::system`, `Qt5::Core`, `GTest::GTest`). Never use the old-style `_LIBRARIES` and `_INCLUDE_DIRS` variables. Imported targets handle all dependency properties for you automatically.
{: .notice--danger}

> :exclamation: **IMPORTANT**
>
> Use a Find module for third party libraries ~~that are not built with CMake~~ that don't support clients to use CMake. Also, report this as a bug to their authors.
{: .notice--danger}

If you need to write a find module for a third-party library, report this as a bug to the authors. Because most people use CMake, it's a problem that don't support it.

### Fetching Dependencies at Configure Time with `FetchContent`

For dependencies that you want to download and build alongside your project, `FetchContent` is the modern, preferred approach. It's great for ensuring all developers use the exact same version of a dependency.

```cmake
include(FetchContent)

# Declare the dependency
FetchContent_Declare(
    googletest
    GIT_REPOSITORY https://github.com/google/googletest.git
    GIT_TAG        release-1.12.1
)

# Make it available (downloads and adds it as a sub-project)
FetchContent_MakeAvailable(googletest)

# Now you can link to it just like any other target in your project
target_link_libraries(my_tests PRIVATE GTest::GTest GTest::Main)
```

> :memo: **Note**
>
> `FetchContent` is generally preferred over Git submodules because it gives the parent project more control and is easier to manage.
{: .notice--info}

### Exporting Your Project as a Package

When you want other projects to use your library with `find_package()`, you need to generate package configuration files.

1. **Install Targets**: Use `install(TARGETS ...)` to specify where your library files (`.a`, `.so`, `.dll`) and headers should be installed. Use the `EXPORT` keyword to associate them with a target export set.
2. **Install Export Set**: Use `install(EXPORT ...)` to create a `<name>Targets.cmake` file. This file contains the definitions of your imported targets (e.g., `MyLib::MyLib`).
3. **Create Version and Config Files**: Use `CMakePackageConfigHelpers` to generate a version file (`<name>ConfigVersion.cmake`) and write a config file (`<name>Config.cmake`). The config file is the entry point that `find_package` looks for.

This process tells other projects how to use your library by defining an imported target like `YourProject::YourLib`.

For example:

```cmake
# standard steps to build the library
find_package(Bar 2.0 REQUIRED)
add_library(Foo ...)
target_link_libraries(Foo PRIVATE Bar::Bar)

# 1. Install targets
install(TARGETS Foo EXPORT FooTargets
    LIBRARY DESTINATION lib
    ARCHIVE DESTINATION lib
    RUNTIME DESTINATION bin
    INCLUDES DESTINATION include)

# 2. Install Export Set
install(EXPORT FooTargets
    FILE FooTargets.cmake
    NAMESPACE Foo::
    DESTINATION lib/cmake/Foo)

# 3. Create Version file
include(CMakePackageConfigHelpers)
write_basic_package_version_file("FooConfigVersion.cmake"
    VERSION ${Foo_VERSION}
    COMPATIBILITY SameMajorVersion
    )
install(FILES "FooConfig.cmake" "FooConfigVersion.cmake"
    DESTINATION lib/cmake/Foo)
```

Create and write config files `FooConfig.cmake`:

```cmake
include(CMakeFindDependencyMacro)
find_dependency(Bar 2.0)
include("$${CMAKE_CURRENT_LIST_DIR}/FooTargets.cmake")
```

## 5. Testing with CTest

CTest is CMake's testing framework. It acts as a test driver, running test executables and reporting results.

### Basic Setup

1. **Enable Testing**: Add `enable_testing()` to your root `CMakeLists.txt`. This command should be called only once in the top-level project.
2. **Add Tests**: Use `add_test()` to define a test case. A test is typically an executable that returns 0 for success and non-zero for failure.

```cmake
# In your tests/CMakeLists.txt
add_executable(run_all_tests tests.cpp)
target_link_libraries(run_all_tests PRIVATE my_lib GTest::GTest GTest::Main)

# Define a test named "MyLib.UnitTests" that runs the "run_all_tests" executable.
add_test(NAME MyLib.UnitTests COMMAND run_all_tests)
```

> :bulb: **TIP**
>
> It's a good practice to adopt a naming convention for your tests, like `Project.Component.TestType`. This makes filtering much easier.
{: .notice--info}

#### Running Tests

You can then run all tests from your build directory:

```shell
# Run all tests, with 4 parallel jobs and verbose output on failure
ctest -j4 --output-on-failure
```

#### Advanced: Filtering Tests

You can run a subset of your tests using a regular expression with the `-R` flag.

```shell
# Run only the tests whose names start with "MyLib."
ctest -R "^MyLib\\."
```

#### Advanced: Testing for Compile Failure

Sometimes, you want to ensure that certain code *fails* to compile (e.g., when testing `static_assert`). You can create a test for this.

```cmake
# Create a library that is expected to fail compilation.
# EXCLUDE_FROM_ALL prevents it from being built during a normal build.
add_library(foo_fail STATIC EXCLUDE_FROM_ALL foo_fail.cpp)

# Add a test that tries to build this specific target.
# The test "passes" if the build command fails.
add_test(NAME Foo.CompileFail
    COMMAND ${CMAKE_COMMAND} --build ${CMAKE_BINARY_DIR} --target foo_fail
)

# We can even check for a specific error message in the build output.
# The test passes if the build fails AND the output contains this regex.
set_tests_properties(Foo.CompileFail PROPERTIES
    PASS_REGULAR_EXPRESSION "static assert message"
    WILL_FAIL TRUE # Informs CTest that a non-zero return code is expected (success)
)
```

#### Advanced: Driving CTest with a Script

For complex testing scenarios, especially in CI/CD environments, you can use a CMake script to drive CTest.

**`build_and_test.cmake`**

```cmake
# This script automates the configure, build, test, and submit steps.
set(CTEST_SOURCE_DIRECTORY "/path/to/source")
set(CTEST_BINARY_DIRECTORY "/path/to/build")

set(CTEST_CMAKE_GENERATOR "Ninja") # Specify the generator

ctest_start("Continuous") # Start a new CTest run
ctest_configure()         # Run cmake
ctest_build()             # Run cmake --build
ctest_test()              # Run ctest
ctest_submit()            # Submit results to a dashboard like CDash
```

You would run this script from the command line:

```shell
ctest -S build_and_test.cmake
```

This keeps CI-specific logic out of your main `CMakeLists.txt`.

## 6. Cross-Compiling with Toolchain Files

Cross-compiling is the process of building code on one machine (the *host*) that is intended to run on a different machine (the *target*), which may have a different architecture (e.g., building for ARM on an x86-64 host).

CMake handles this through **Toolchain Files**. A toolchain file tells CMake how to find the correct compilers, linkers, and libraries for the target system.

### The Role of the Toolchain File

You specify the toolchain file when you first configure your project with `cmake`.

```shell
# Configure the project using the my-arm-toolchain.cmake file
cmake -S . -B build -DCMAKE_TOOLCHAIN_FILE=/path/to/my-arm-toolchain.cmake
```

> :warning: **WARNING**
>
> A toolchain file is for describing the **environment**, not for project logic. Avoid setting project options or variables in it. Its only job is to set up the compilers and search paths.
{: .notice--warning}

#### Example Toolchain File

Here is an example of a toolchain file for cross-compiling to Windows from a Linux host using MinGW-w64.

**`mingw-toolchain.cmake`**

```cmake
# The name of the target operating system
set(CMAKE_SYSTEM_NAME Windows)

# Specify the cross-compilers
set(CMAKE_C_COMPILER   x86_64-w64-mingw32-gcc)
set(CMAKE_CXX_COMPILER x86_64-w64-mingw32-g++)

# Where to find the target environment's headers and libraries
set(CMAKE_FIND_ROOT_PATH /usr/x86_64-w64-mingw32)

# Adjust the search behavior for programs, libraries, and includes
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)

# Set an emulator to run target executables on the host system
set(CMAKE_CROSSCOMPILING_EMULATOR "wine64")
```

#### Running Cross-Compiled Tests

You can't directly run a target executable on the host machine. The `CMAKE_CROSSCOMPILING_EMULATOR` variable (set in the toolchain file) tells CTest how to run the tests. It specifies a program (like `wine` for Windows apps on Linux, or `qemu-arm` for ARM binaries) that can emulate the target environment.

When you run `ctest`, it will automatically prefix test commands with the emulator:

```shell
# CTest will effectively run:
wine64 my_test_executable.exe
```

This allows you to run your unit tests on the host machine even when cross-compiling.

## 7. Packaging with CPack

CPack is CMake's packaging tool. It can create installers (NSIS, WiX), archives (`.zip`, `.tar.gz`), and Linux packages (`.deb`, `.rpm`).

1. **Include CPack**: Add `include(CPack)` to your root `CMakeLists.txt`.
2. **Set CPack Variables**: Configure package metadata by setting `CPACK_*` variables.

```cmake
set(CPACK_PACKAGE_NAME "MyAwesomeApp")
set(CPACK_PACKAGE_VERSION "1.0.0")
set(CPACK_GENERATOR "ZIP;TGZ") # Create a .zip and a .tar.gz
# ... other variables
```

Run CPack from your build directory to create the packages:

```shell
cpack
```

## 8. Static Analysis Integration

Integrating static analysis into the build process is a powerful way to enforce code quality and catch bugs early.

### The Philosophy of Handling Warnings

A common piece of advice is to "treat warnings as errors," typically by passing the `-Werror` flag to the compiler. However, this approach can be counterproductive and painful.

**Why `-Werror` Causes Pain:**

- **Blocks Progress**: You cannot enable `-Werror` until you have fixed every single existing warning in the codebase.
- **Hinders Upgrades**: You cannot upgrade your compiler or increase the warning level (e.g., from `-Wall` to `-Wextra`) until you have fixed all the new warings that appear. This creates a significant barrier to modernization.
- **Makes Deprecation Difficult**: You cannot mark your own internal APIs as `[[deprecated]]` as long as they are still in use, because this would generate a warning and fail the build. But once they are no longer used, you might as well just remove them.

### A Better Approach: Treat *New* Warnings as Errors

A more practical and agile strategy is to manage warnings in development cycles:

1. **Allow New Warnings Temporarily**: At the beginning of a development cycle (e.g., a new sprint), allow new warnings to be introduced. This is the time to upgrade compilers, update dependencies, or enable more aggressive warning flags.
2. **Burn Down Warnings**: During the cycle, the team's goal is to fix all existing warnings and drive the count back down to zero.
3. **Repeat**: This iterative process allows for continuous improvement without bringing development to a halt.

### Pull Out All the Stops: Powerful Analysis Tools

Modern C++ has a rich ecosystem of static analysis tools that go far beyond compiler warnings. You should integrate them into your build.

- **clang-tidy**: A Clang-based linter framework to diagnose and fix typical programming errors, style violations, and interface misuse.
  **cpplint**: An automated checker to ensure code adheres to Google's C++ style guide.
- **include-what-you-use (IWYU)**: A tool for analyzing `#include`s to ensure you include exactly what you use, which can improve compile times and code clarity.
- **clazy**: A Clang plugin that finds Qt-specific antipatterns and performance issues.

### Modern CMake Integration via Target Properties

Modern CMake provides dedicated target properties to run these tools alongside the compiler.

- `<LANG>_CLANG_TIDY`
- `<LANG>_CPPLINT`
- `<LANG>_INCLUDE_WHAT_YOU_USE`
- `LINK_WHAT_YOU_USE` (Checks for unused library links)

Where `<LANG>` is `C` or `CXX`. These properties are initialized by their corresponding `CMAKE_...` variables.

```cmake
# Example of enabling clang-tidy and include-what-you-use
set_target_properties(my_app PROPERTIES
    CXX_CLANG_TIDY "clang-tidy;-checks=-*,readability-*,modernize-*"
    CXX_INCLUDE_WHAT_YOU_USE "include-what-you-use;-Xiwyu;--mapping_file=/iwyu.imp"
)
```

> :exclamation: **IMPORTANT**
>
> The major advantage of this approach is that diagnostics from these tools are seamlessly integrated into your build output and appear directly in your IDE, just like regular compiler errors and warnings.
{: .notice--danger}

### Best Practice: Analyzing Header Files

A common pitfall is that header files without an associated source file (.cpp) will not be analyzed.

> :bulb: **TIP**
>
> For each header file, ensure there is an associated source file that `#include` it, preferably as the very first line. This source file can even be empty otherwise.
{: .notice--info}

You can use a simple script to create these missing source files:

```shell
#!/usr/bin/env bash
# Create an empty .cpp file for every .h file that doesn't have one.
for fn in `comm -23 \
            <(ls *.h | cut -d '.' -f 1 | sort) \
            <(ls *.c *.cpp | cut -d '.' -f 1 | sort)`
do
    echo "#include \"$fn.h\"" >> $fn.cpp
done
```

Enabling Analysis from Outside the Project

To keep your `CMakeLists.txt` clean, you can enable and configure these tools from the command line during the configure step. This is ideal for CI/CD pipelines.

## Reference

- [Effective CMake: a random selectino of best practices](https://www.youtube.com/watch?v=bsXLMQ6WgIk)
- [CMake Documentation and Community](https://cmake.org/documentation/)
