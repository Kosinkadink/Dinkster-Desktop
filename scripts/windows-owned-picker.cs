using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class OwnedPicker {
    private delegate bool Callback(IntPtr window, IntPtr data);
    // Native boundary is replaced as a whole by the benign validation harness.
    private static class Native {
        [DllImport("user32.dll")] internal static extern bool EnumWindows(Callback callback, IntPtr data);
        [DllImport("user32.dll")] internal static extern bool EnumChildWindows(IntPtr parent, Callback callback, IntPtr data);
        [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetClassNameW(IntPtr window, StringBuilder text, int capacity);
        [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode)] internal static extern IntPtr ReadText(IntPtr window, uint message, IntPtr capacity, StringBuilder text, uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll")] internal static extern bool IsChild(IntPtr parent, IntPtr child);
        [DllImport("user32.dll")] internal static extern int GetDlgCtrlID(IntPtr child);
        [DllImport("user32.dll")] internal static extern IntPtr GetParent(IntPtr child);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW")] internal static extern IntPtr SendNumeric(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll", EntryPoint = "PostMessageW")] internal static extern bool PostNumeric(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    }
    // End native boundary.

    public sealed class Control {
        public IntPtr Handle;
        public int Id;
        public string ClassName;
        public string Text;
    }

    private static string Read(IntPtr window, bool className) {
        var text = new StringBuilder(32768);
        int size;
        if (className) size = Native.GetClassNameW(window, text, text.Capacity);
        else {
            IntPtr result;
            // GetWindowText cannot retrieve another process's edit contents.
            if (Native.ReadText(window, 0x000D, new IntPtr(text.Capacity), text, 2, 2000, out result) == IntPtr.Zero)
                throw new InvalidOperationException("Native control text read timed out");
            size = result.ToInt32();
        }
        if (size >= text.Capacity - 1) throw new InvalidOperationException("Truncated native control text");
        return text.ToString();
    }

    private static bool Owned(IntPtr window, uint owner) {
        uint pid;
        return Native.GetWindowThreadProcessId(window, out pid) != 0 && pid == owner;
    }

    public static IntPtr Dialog(uint owner) {
        var dialogs = new List<IntPtr>();
        if (!Native.EnumWindows((window, data) => {
            if (Owned(window, owner) && Read(window, true) == "#32770") dialogs.Add(window);
            return true;
        }, IntPtr.Zero)) throw new InvalidOperationException("Window enumeration failed");
        if (dialogs.Count > 1) throw new InvalidOperationException("Ambiguous owned dialogs");
        return dialogs.Count == 0 ? IntPtr.Zero : dialogs[0];
    }

    public static Control Validate(IntPtr dialog, uint owner, IntPtr handle) {
        if (dialog == IntPtr.Zero || Dialog(owner) != dialog || handle == IntPtr.Zero ||
            !Native.IsChild(dialog, handle) || !Owned(handle, owner))
            throw new InvalidOperationException("Native control ownership changed");
        return new Control { Handle = handle, Id = Native.GetDlgCtrlID(handle), ClassName = Read(handle, true), Text = Read(handle, false) };
    }

    public static Control[] Controls(IntPtr dialog, uint owner) {
        if (dialog == IntPtr.Zero || Dialog(owner) != dialog) throw new InvalidOperationException("Dialog identity changed");
        var controls = new List<Control>();
        Exception failure = null;
        Native.EnumChildWindows(dialog, (window, data) => {
            try {
                if (controls.Count >= 512) throw new InvalidOperationException("Native control census exceeded bound");
                controls.Add(Validate(dialog, owner, window));
            } catch (Exception error) { failure = error; return false; }
            return true;
        }, IntPtr.Zero);
        if (failure != null) throw failure;
        return controls.ToArray();
    }

    public static IntPtr AddressBand(IntPtr dialog, uint owner, IntPtr toolbar) {
        Control control = Validate(dialog, owner, toolbar);
        if (control.ClassName != "ToolbarWindow32" || !control.Text.StartsWith("Address: ", StringComparison.Ordinal))
            throw new InvalidOperationException("Address toolbar identity mismatch");
        IntPtr parent = Native.GetParent(toolbar);
        for (int depth = 0; depth < 8 && parent != dialog && parent != IntPtr.Zero; depth++) {
            Control ancestor = Validate(dialog, owner, parent);
            if (ancestor.ClassName == "Address Band Root") return parent;
            parent = Native.GetParent(parent);
        }
        throw new InvalidOperationException("Address band ancestor unavailable");
    }

    public static Control AddressEdit(IntPtr dialog, uint owner, IntPtr band) {
        if (Validate(dialog, owner, band).ClassName != "Address Band Root") throw new InvalidOperationException("Address band changed");
        Control result = null;
        foreach (Control control in Controls(dialog, owner)) {
            if (control.ClassName != "Edit" || !Native.IsChild(band, control.Handle)) continue;
            if (result != null) throw new InvalidOperationException("Ambiguous address edits");
            result = control;
        }
        return result;
    }

    public static Control Button(IntPtr dialog, uint owner, string caption) {
        Control result = null;
        foreach (Control control in Controls(dialog, owner)) {
            if (control.ClassName != "Button" || control.Text.Replace("&", "") != caption) continue;
            if (result != null) throw new InvalidOperationException("Ambiguous named buttons");
            result = control;
        }
        if (result == null) throw new InvalidOperationException("Named button unavailable");
        return result;
    }

    private static void Same(IntPtr dialog, uint owner, Control expected, string className) {
        Control current = Validate(dialog, owner, expected.Handle);
        if (current.Id != expected.Id || current.ClassName != className || expected.ClassName != className || current.Text != expected.Text)
            throw new InvalidOperationException("Native control identity changed before input");
    }

    public static void SetAddress(IntPtr dialog, uint owner, IntPtr band, Control edit, string path) {
        Same(dialog, owner, edit, "Edit");
        Control current = AddressEdit(dialog, owner, band);
        if (current == null || current.Handle != edit.Handle) throw new InvalidOperationException("Address edit ancestry changed");
        IntPtr result;
        if (Native.SendMessageTimeoutW(edit.Handle, 0x000C, IntPtr.Zero, path, 2, 2000, out result) == IntPtr.Zero || result == IntPtr.Zero)
            throw new InvalidOperationException("Address WM_SETTEXT failed");
        Control readback = Validate(dialog, owner, edit.Handle);
        if (readback.Id != edit.Id || readback.ClassName != "Edit" || readback.Text != path)
            throw new InvalidOperationException("Address edit exact readback mismatch");
    }

    public static void CommitAddress(IntPtr dialog, uint owner, IntPtr band, Control edit) {
        Same(dialog, owner, edit, "Edit");
        Control current = AddressEdit(dialog, owner, band);
        if (current == null || current.Handle != edit.Handle) throw new InvalidOperationException("Address edit ancestry changed");
        // Queue Enter on this edit only, so the dialog's message loop commits navigation.
        if (!Native.PostNumeric(edit.Handle, 0x0100, new IntPtr(13), new IntPtr(1)) ||
            !Native.PostNumeric(edit.Handle, 0x0101, new IntPtr(13), new IntPtr(unchecked((int)0xC0000001))))
            throw new InvalidOperationException("Address commit message failed");
    }

    public static void Click(IntPtr dialog, uint owner, Control button) {
        Same(dialog, owner, button, "Button");
        IntPtr result;
        if (Native.SendNumeric(button.Handle, 0x00F5, IntPtr.Zero, IntPtr.Zero, 2, 2000, out result) == IntPtr.Zero)
            throw new InvalidOperationException("Button message failed");
    }
}
