/** A template's written content, loaded into the library by `syncContent`. */
export type ContentTemplate = {
  templateKey: string;
  summary: string;
  sections: readonly { heading: string; body: string }[];
};

export type ContentPack = {
  packRef: string;
  title: string;
  /** Category = module, loaded one at a time. */
  moduleKey: string;
  templates: readonly ContentTemplate[];
};
