declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    setImage: {
      setImage: (options: { src: string; alt?: string }) => ReturnType;
    };
  }
}

export {};
